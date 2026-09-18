/**
 * Turning room traffic into one prompt — the driver's copy of the framing the
 * lobby used when it ran the agent itself.
 *
 * It lives here (rather than being imported from the lobby) because the prompt is
 * the *agent's* input, and this package is the side that owns the agent. The
 * rules are deliberately the same as `src/room-turn.mjs`: a header that reads as
 * a title, a bounded digest of what the room has been saying, the trigger lines
 * verbatim, and a closing line that names the bot.
 * @module dsh-lobby-bot/prompt
 */

/** Hard cap on one rendered room line inside a digest. */
const MAX_LINE_CHARS = 300;

/**
 * Render one message as a digest line.
 *
 * Kept in step with the lobby's own `src/room-turn.mjs`, including the
 * attachment rendering: the two sides must describe the same room the same way,
 * or a bot behaves differently depending on who drives it.
 * @param message - a room message (`{kind, author, text, meta}`).
 * @returns a single-line rendering.
 */
function digestLine(message) {
  const who = message.kind === "system" ? "系统" : message.author?.nick ?? "?";
  const body = String(message.text ?? "").replace(/\s+/g, " ").trim();
  const clipped = body.length > MAX_LINE_CHARS ? `${body.slice(0, MAX_LINE_CHARS)}…` : body;
  const file = fileLine(message);
  return `${who}：${clipped}${file === "" ? "" : `${clipped === "" ? "" : " "}${file}`}`;
}

/**
 * Render the attachment part of a room line.
 *
 * A bot reads a file the same way a browser does — it fetches the lobby's own
 * download URL with the personal token it already holds — so the link has to
 * travel with the message. Storage credentials never enter a prompt.
 * @param message - a room message.
 * @returns e.g. `[文件] 报告.pdf，1.2 MB http://host/api/files/…`, or `""`.
 */
function fileLine(message) {
  const file = message?.meta?.file;
  if (file === null || typeof file !== "object" || typeof file.name !== "string") return "";
  const size = Number.isFinite(file.size) ? `，${formatSize(file.size)}` : "";
  // 字节已经不在存储里（服务端刷新时对账出的结论）：名字与大小照给，但不再递一个
  // 注定 404 的链接，免得 bot 为一个取不到的字节白跑一轮。
  if (file.missing === true) return `[文件] ${file.name}${size}（已不在对象存储里，取不到字节）`;
  const url = typeof file.url === "string" && file.url.length > 0 ? ` ${file.url}` : "";
  return `[文件] ${file.name}${size}${url}`;
}

/** Human-readable byte size for a prompt line. */
function formatSize(size) {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Build a bounded summary of recent room traffic.
 *
 * Recent messages win: the byte budget is spent walking backwards from the newest
 * message, then the selected lines are restored to chronological order.
 *
 * `exclude` keeps the digest out of the way of the triggers: the triggering
 * message reaches the room before it reaches the bot, so without this it would be
 * rendered once as history and once as the thing being answered.
 * @param options - digest inputs.
 * @param options.messages - room messages, oldest first.
 * @param options.botId - the bot whose own messages are excluded.
 * @param options.exclude - messages already carried by the trigger lines.
 * @param options.maxMessages - message cap.
 * @param options.maxBytes - byte cap.
 * @returns the digest text, or an empty string when nothing qualifies.
 */
export function buildDigest({ messages, botId, exclude = [], maxMessages = 12, maxBytes = 4096 }) {
  // Matched by identity and by sequence number: whichever handle the caller has,
  // the same room message must not be quoted twice in one prompt.
  const exclusion = new Set();
  for (const message of exclude) {
    exclusion.add(message);
    if (Number.isInteger(message.seq)) exclusion.add(`${message.seq}`);
  }
  const eligible = messages.filter(
    (message) =>
      message.kind !== "system" &&
      !(message.kind === "bot" && message.author?.id === `bot_${botId}`) &&
      !exclusion.has(message) &&
      !exclusion.has(`${message.seq}`),
  );
  const selected = [];
  let bytes = 0;
  for (let index = eligible.length - 1; index >= 0 && selected.length < maxMessages; index -= 1) {
    const line = digestLine(eligible[index]);
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + cost > maxBytes && selected.length > 0) break;
    bytes += cost;
    selected.push(line);
  }
  return selected.reverse().join("\n");
}

/** Format a timestamp as `MM-DD HH:mm` in local time. */
export function stamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The placeholder the lobby leaves for the current room in its manual.
 *
 * Kept in sync with `dsh-chat-room/src/bot-manual.mjs`; it is the only part of
 * the manual this side is allowed to understand.
 */
export const MANUAL_ROOM_PLACEHOLDER = "{{roomId}}";

/**
 * Render the framed prompt for one turn.
 * @param options - prompt inputs.
 * @param options.bot - the bot (`{id, nick, persona, manual}`).
 * @param options.roomId - the room the turn belongs to.
 * @param options.roomName - display name of the room.
 * @param options.triggers - the messages the bot is answering, oldest first.
 * @param options.digest - room history, injected only on a cold session.
 * @param options.includeDigest - whether to include `digest`.
 * @param options.now - clock.
 * @returns the prompt text.
 */
export function formatPrompt({ bot, roomId, roomName, triggers, digest, includeDigest, now = new Date() }) {
  const lines = [`【${bot.nick}】 ${roomName} ${stamp(now)} ·`];
  if (includeDigest && typeof digest === "string" && digest.trim().length > 0) {
    lines.push("（以下是你在本房间看到的最近记录，仅供参考，不要逐条复述）", digest, "——");
  }
  for (const trigger of triggers) lines.push(digestLine(trigger));
  lines.push(
    "——",
    bot.persona.length > 0
      ? bot.persona
      : `你是聊天室「Lobby」的成员「${bot.nick}」。请用简短、口语化的中文回应上面最后一条内容，直接给结论或命令，不要复述这段设定。`,
  );
  const manual = manualBlock(bot.manual, roomId);
  if (manual.length > 0) lines.push(manual);
  return lines.join("\n");
}

/**
 * Substitute the room placeholder and return the lobby's manual.
 *
 * The manual is lobby-owned text: this side never interprets it, it only fills
 * in the one value the driver knows and the lobby could not (which room the turn
 * belongs to). An absent manual yields an empty string, so an older lobby that
 * does not send one simply produces a prompt without the block.
 * @param manual - the lobby's manual text, or undefined.
 * @param roomId - the room the turn belongs to.
 * @returns the manual text, or `""` when there is nothing to append.
 */
function manualBlock(manual, roomId) {
  if (typeof manual !== "string" || manual.length === 0) return "";
  const room = typeof roomId === "string" ? roomId : "";
  return manual.split(MANUAL_ROOM_PLACEHOLDER).join(room);
}

/**
 * The session title the driver pins for one bot in one room.
 *
 * Explicit titles are better than the derived one here: DSH would otherwise take
 * the first five words of the prompt, which is right by accident, and the room
 * name belongs in the title.
 * @param options - title inputs.
 * @param options.nick - the bot's display name.
 * @param options.roomName - display name of the room.
 * @returns the title.
 */
export function sessionTitle({ nick, roomName }) {
  return `【${nick}】 ${roomName}`;
}

/**
 * Merge several queued triggers into one turn, collapsing exact repeats.
 *
 * Keyed on author + text, not seq: a repeat is by definition a different message,
 * so only the text can tell the model "this was asked once".
 */
export function mergeTriggers(messages) {
  const seen = new Set();
  const triggers = messages.filter((message) => {
    const key = `${message.author?.id ?? message.author?.nick ?? "?"}\u0000${message.text ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { triggers, merged: Math.max(0, triggers.length - 1) };
}

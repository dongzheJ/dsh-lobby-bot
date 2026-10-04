/**
 * Bridging DSH's `ask_user_question` tool into a chat room.
 *
 * The tool pauses the agent until a human answers, and the only answerer DSH
 * ships is the GUI. A lobby-driven bot has no GUI in front of it, so the driver
 * posts the question into the room and treats the next human message that
 * mentions the bot as the answer. This module owns the two halves of that
 * contract — rendering the question and reading the reply — and nothing else, so
 * both can be tested without a host, a socket, or a model.
 * @module dsh-lobby-bot/question
 */

/** Hard cap on one rendered question, so a runaway prompt cannot flood the room. */
const MAX_QUESTION_CHARS = 500;

/** How many questions one `ask_user_question` call may carry before we clip. */
const MAX_QUESTIONS = 10;

/**
 * Remove the bot's own names from a room reply, leaving the answer.
 *
 * `@nick` is stripped anywhere; a bare nick is stripped only at the head of the
 * message, because room chatter writes both and the body must not lose words
 * that happen to equal the name.
 * @param text - the raw room message.
 * @param mentions - the bot's names (`bot.mentions`).
 * @returns the answer text.
 */
export function stripMentions(text, mentions = []) {
  let out = String(text ?? "");
  for (const name of mentions) {
    if (typeof name !== "string" || name.length === 0) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`@${escaped}`, "gi"), " ");
    out = out.replace(new RegExp(`^\\s*${escaped}[\\s，,：:]+`, "i"), "");
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Whether a question carries choices. */
function hasOptions(question) {
  return Array.isArray(question?.options) && question.options.length > 0;
}

/** Clip one question to a room-sized line. */
function clip(text) {
  return text.length > MAX_QUESTION_CHARS ? `${text.slice(0, MAX_QUESTION_CHARS)}…` : text;
}

/**
 * Match one reply token to an option.
 *
 * Accepts either the 1-based position the room was shown or the label itself, so
 * both "2" and "SQLite" answer the same option.
 * @param question - the question with `options`.
 * @param token - one reply token.
 * @returns the matched label, or `undefined`.
 */
export function matchOption(question, token) {
  const value = String(token ?? "").trim();
  if (value.length === 0) return undefined;
  const options = Array.isArray(question?.options) ? question.options : [];
  if (/^\d+$/.test(value)) {
    const index = Number(value) - 1;
    return index >= 0 && index < options.length ? options[index].label : undefined;
  }
  const lower = value.toLowerCase();
  return options.find((option) => String(option.label).trim().toLowerCase() === lower)?.label;
}

/** Split a reply into tokens on the separators a room actually types. */
function splitTokens(text) {
  return String(text ?? "")
    .split(/[\n,，、;；]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * Read one question's answer out of the reply body.
 * @param question - the question (`{id, options?, multiSelect?}`).
 * @param body - the reply body with mentions already stripped.
 * @returns `{id, selected, custom?}`, or `undefined` when there is nothing to read.
 */
export function parseSingle(question, body) {
  const text = String(body ?? "").trim();
  if (text.length === 0) return undefined;
  const id = String(question?.id);
  if (hasOptions(question)) {
    const tokens = splitTokens(text);
    const matched = tokens.map((token) => matchOption(question, token));
    if (tokens.length > 0 && matched.every((label) => label !== undefined)) {
      // 单选问题里写了多个词：只要每个词都是选项就取第一个，否则整句当自由文本，
      // 免得把「2 号方案，但是先别动」这种带态度的回答吞成一个选项。
      const selected = question.multiSelect ? [...new Set(matched)] : [matched[0]];
      return { id, selected };
    }
  }
  return { id, selected: [], custom: text };
}

/**
 * Read a whole reply into the answer batch `ask_user_question` expects.
 *
 * One question takes the whole body. Several questions take one line each, in
 * order, or explicitly numbered `1.` / `1:` / `1)`; a reply that does not cover
 * every question is refused (`undefined`) so the driver can ask again instead of
 * answering half a batch.
 * @param options - parse inputs.
 * @param options.questions - the questions from the request.
 * @param options.text - the reply body with mentions already stripped.
 * @returns `{answers}` or `undefined` when the reply cannot be read.
 */
export function parseAnswer({ questions, text }) {
  const list = Array.isArray(questions) ? questions : [];
  if (list.length === 0) return undefined;
  const body = String(text ?? "").trim();
  if (body.length === 0) return undefined;
  if (list.length === 1) {
    const answer = parseSingle(list[0], body);
    return answer === undefined ? undefined : { answers: [answer] };
  }
  const lines = body
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const numbered = lines.every((line) => /^\d+\s*[.、:：)）]/.test(line));
  const slots = new Map();
  if (numbered) {
    for (const line of lines) {
      const match = /^(\d+)\s*[.、:：)）]\s*(.*)$/.exec(line);
      const index = Number(match[1]) - 1;
      if (index < 0 || index >= list.length || slots.has(index)) return undefined;
      slots.set(index, match[2]);
    }
  } else {
    if (lines.length !== list.length) return undefined;
    lines.forEach((line, index) => slots.set(index, line));
  }
  if (slots.size !== list.length) return undefined;
  const answers = list.map((question, index) => parseSingle(question, slots.get(index)) ?? {
    id: String(question?.id),
    selected: [],
    custom: slots.get(index),
  });
  return { answers };
}

/**
 * Render the room message that carries a question.
 * @param options - render inputs.
 * @param options.nick - the bot's display name (the mention the room must use).
 * @param options.questions - the questions from the request.
 * @returns the room text.
 */
export function formatQuestionMessage({ nick, questions }) {
  const list = (Array.isArray(questions) ? questions : []).slice(0, MAX_QUESTIONS);
  const lines = [];
  const multi = list.length > 1;
  list.forEach((question, index) => {
    const header = typeof question.header === "string" && question.header.trim().length > 0
      ? `${question.header.trim()}：`
      : "";
    const body = clip(String(question.question ?? "").trim());
    lines.push(`❓ ${multi ? `${index + 1}. ` : ""}${header}${body}`);
    const options = Array.isArray(question.options) ? question.options : [];
    options.forEach((option, optionIndex) => {
      const description = typeof option.description === "string" && option.description.trim().length > 0
        ? ` — ${option.description.trim()}`
        : "";
      lines.push(`   ${optionIndex + 1}) ${String(option.label ?? "").trim()}${description}`);
    });
  });
  const how = multi
    ? "每个问题一行，按 1. 2. … 的顺序回答"
    : hasOptions(list[0])
      ? "回复序号或选项文字即可"
      : "直接回复文字即可";
  lines.push(`（@${nick} ${how}；多选可用逗号分隔）`);
  return lines.join("\n");
}

/**
 * Build the answer used when nobody in the room replies in time.
 *
 * Answering (rather than failing the tool) is what lets the agent finish its
 * turn with its own judgement instead of stalling until the whole prompt times
 * out and the room gets nothing.
 * @param questions - the questions from the request.
 * @param note - the instruction fed back to the agent.
 * @returns the answer batch.
 */
export function noAnswer(questions, note) {
  const list = Array.isArray(questions) ? questions : [];
  return {
    answers: list.map((question) => ({ id: String(question?.id), selected: [], custom: note })),
  };
}

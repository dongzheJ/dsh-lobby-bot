/**
 * Goal-mode awareness for room drivers.
 *
 * DSH "goal mode" (`dsh-goal` + `dsh-tool-goal` + `dsh-goal-round-driver`)
 * continues an active goal in the same session whenever the agent is idle,
 * without any room message triggering it. Those autonomous rounds never touch
 * the driver's room-turn collector, so the work they do was invisible in the
 * room. This module owns the pure half of the fix: recognising the one notice
 * worth acting on and rendering the room message it produces.
 *
 * Posting every round was rejected as noise — round output is mostly tool
 * narration ("Let me read…", "Let me edit…"). The room only sees the single
 * closing message the model writes when it reports the goal `complete` or
 * `blocked`, which `dsh-tool-goal` explicitly asks it to write (`wrapup.ts`).
 * @module dsh-lobby-bot/goal-wrap
 */

/** Concatenate the text blocks of a content-block array. */
export function contentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/**
 * Recognise the goal tool's terminal wrap-up notice.
 *
 * `dsh-tool-goal` injects exactly one user-role notice after an autonomous round
 * reports `complete` or `blocked`; the model's next (and final) message in that
 * turn is the closing summary. `<goal_round>` continuations and ordinary room
 * traffic are not wrap-ups.
 * @param message - a session `user/message` payload (`{source, content}`).
 * @returns `{kind, objective, blockedReason}` when it is a wrap-up, else `undefined`.
 */
export function parseGoalWrap(message) {
  if (message?.source?.kind !== "tool-goal") return undefined;
  const text = contentText(message?.content);
  const complete = text.includes("<goal_complete>");
  const blocked = text.includes("<goal_blocked>");
  if (!complete && !blocked) return undefined;
  return {
    kind: blocked ? "blocked" : "complete",
    objective: readJsonField(text, "Objective:"),
    blockedReason: blocked ? readJsonField(text, "Blocked:") : undefined,
  };
}

/**
 * Read one `Label: "json string"` field out of a goal notice.
 *
 * The notice writes `JSON.stringify(value)` on its own line, so the value is a
 * complete JSON string and can be decoded (not sliced) — an objective that
 * contains a quote survives intact.
 * @param text - the notice body.
 * @param label - the field label including its colon.
 * @returns the decoded value, or `undefined` when absent or malformed.
 */
function readJsonField(text, label) {
  const at = text.indexOf(label);
  if (at < 0) return undefined;
  const line = text.slice(at + label.length).split("\n", 1)[0].trim();
  if (!line.startsWith('"')) return undefined;
  try {
    const value = JSON.parse(line);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Render the one room message a goal completion/block produces.
 *
 * The closing summary is the payload; the header only tells the room *why* an
 * otherwise unrequested message arrived. When the model wrote nothing (a
 * cancelled turn, a provider that produced no text) fall back to the goal's own
 * metadata so the room still learns the outcome.
 * @param options - wrap-up inputs.
 * @param options.wrap - the parsed wrap-up from {@link parseGoalWrap}.
 * @param options.body - the model's closing message (`""` when it wrote none).
 * @returns the room text.
 */
export function formatGoalWrap({ wrap, body }) {
  const head = wrap.kind === "blocked" ? "【目标受阻】" : "【目标完成】";
  const closing = String(body ?? "").trim();
  if (closing.length > 0) return `${head}\n\n${closing}`;
  const fallback = wrap.kind === "blocked" ? wrap.blockedReason : wrap.objective;
  return fallback === undefined ? head : `${head}\n\n${fallback}`;
}

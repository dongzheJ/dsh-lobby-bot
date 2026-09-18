/**
 * When to answer, and what to do when the room talks faster than the bot can.
 *
 * The lobby enforces these rules for bots it runs itself; a DSH-driven bot runs
 * elsewhere, so the same policy has to live on this side. It is deliberately pure
 * — no clock, no I/O — because this is the logic whose failure mode is a bot that
 * answers twice, answers a message addressed to someone else, or silently drops a
 * question it was asked.
 *
 * The lobby drops the `mention` event once a bot-to-bot run is over budget, so in
 * a healthy deployment this file never sees the runaway case. It still applies the
 * same rule locally: a policy that is only correct because the other side of the
 * seam happens to enforce it is not a policy, and the `always` mode never goes
 * through the lobby's mention gate at all.
 * @module dsh-lobby-bot/turn-policy
 */

/**
 * Default conversation budget between bots; mirrors `DEFAULT_MAX_BOT_CHAIN`.
 *
 * Kept as its own constant rather than imported from the lobby: this module must
 * stay loadable (and testable) without the lobby checkout, which is the whole
 * point of the plugin living in its own package.
 */
export const DEFAULT_MAX_BOT_CHAIN = 3;

/**
 * Length of the trailing run of bot messages in a room history.
 *
 * Mirrors the lobby's `Room.trailingBotRun()`: system lines are transparent,
 * because a presence or merge notice is not a human taking the floor. The caller
 * passes the history it already keeps, ending with the message being judged.
 * @param messages - room messages, oldest first.
 * @returns how many bot messages run consecutively at the end.
 */
export function botChainLength(messages) {
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const kind = messages[index]?.kind;
    if (kind === "system") continue;
    if (kind !== "bot") break;
    count += 1;
  }
  return count;
}

/** A bot's conversation budget, falling back to the default for hand-built configs. */
export function maxBotChainOf(bot) {
  return Number.isInteger(bot.maxBotChain) && bot.maxBotChain >= 0 ? bot.maxBotChain : DEFAULT_MAX_BOT_CHAIN;
}

/**
 * Whether one room event should start a turn.
 *
 * `mention` events are computed by the lobby from the bot's own `mentions` list,
 * so this only has to honour the two modes: a `mention`-mode bot answers when it
 * is addressed, an `always`-mode bot answers anything a human says, rate-limited.
 *
 * `minIntervalMs` is applied to bot-authored triggers only. A person who names a
 * bot is answered immediately even inside the interval, because cooling a human's
 * question down means silently dropping it — this module's decision is made before
 * the queue, so a rejection here is a lost message, not a deferred one.
 * @param options - decision inputs.
 * @param options.bot - the bot (`{mode, minIntervalMs, maxBotChain}`).
 * @param options.event - `mention` or `message`.
 * @param options.message - the room message.
 * @param options.lastTurnAt - when this bot's previous turn in this room started.
 * @param options.botChain - the run of bot messages this message ends.
 * @param options.now - clock.
 * @returns `true` when a turn should start.
 */
export function shouldTrigger({ bot, event, message, lastTurnAt, botChain = 0, now }) {
  if (message?.kind === "system") return false;
  // A bot never answers itself; that is a loop, not a conversation.
  if (message?.kind === "bot" && message.author?.id === `bot_${bot.id}`) return false;
  if (event !== "mention" && event !== "message") return false;
  const fromBot = message?.kind === "bot";

  if (bot.mode === "always") {
    // An "always" bot answers the room, not the bots in it. Mirrors the lobby's
    // own rule; without it this branch had no bot check at all.
    if (fromBot) return false;
    if (event === "mention") return true;
    return lastTurnAt === undefined || now - lastTurnAt >= bot.minIntervalMs;
  }
  if (event !== "mention") return false;
  if (!fromBot) return true;
  if (botChain > maxBotChainOf(bot)) return false;
  return lastTurnAt === undefined || now - lastTurnAt >= bot.minIntervalMs;
}

/**
 * Per-(bot, room) turn queue.
 *
 * One turn at a time, and overflow merges into the last queued turn instead of
 * being dropped: the room asked a question, so the honest failure is answering it
 * later, not losing it. Mirrors the lobby's own queue semantics.
 */
export class TurnQueue {
  #limit;
  #pending = [];
  running = false;
  /** How many messages were folded into queued turns since the last turn started. */
  merged = 0;

  /**
   * @param options - queue options.
   * @param options.limit - how many turns may wait behind the running one.
   */
  constructor({ limit }) {
    this.#limit = Math.max(1, limit);
  }

  /** How many turns are waiting. */
  get size() {
    return this.#pending.length;
  }

  /**
   * Offer one trigger.
   * @param trigger - the room message to answer.
   * @returns `run` when the caller should start a turn, `queued`/`merged` otherwise.
   */
  push(trigger) {
    if (!this.running) {
      this.running = true;
      return "run";
    }
    if (this.#pending.length >= this.#limit) {
      const last = this.#pending[this.#pending.length - 1];
      last.push(trigger);
      this.merged += 1;
      return "merged";
    }
    this.#pending.push([trigger]);
    return "queued";
  }

  /**
   * Finish the running turn and take the next batch, if any.
   * @returns the next batch of triggers, or `undefined` when the queue is empty.
   */
  next() {
    this.merged = 0;
    const batch = this.#pending.shift();
    if (batch === undefined) {
      this.running = false;
      return undefined;
    }
    return batch;
  }

  /** Drop everything waiting (the room cancelled the work). */
  clear() {
    this.#pending = [];
    this.merged = 0;
  }
}

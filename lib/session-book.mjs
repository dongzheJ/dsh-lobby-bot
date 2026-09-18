/**
 * Which DSH session backs which room — the anchor of a bot's memory.
 *
 * A bot's memory is a session id, and this host keeps that mapping in its own
 * harness home (`$DSH_HOME/lobby-login.json`, see `local-store.mjs`). The lobby
 * used to own it; after `/lobby <url> <token>` the driver is the only party that can see
 * the sessions it created, so it owns the book too.
 *
 * The lobby's own `data/state.json` is no longer consulted: a driver that logged
 * in over the network never had that file to begin with, and reading it on one
 * machine but not another is exactly the kind of divergence this refactor removed.
 * @module dsh-lobby-bot/session-book
 */

/**
 * The session a room should use, and whether it already exists.
 *
 * Adoption is decided by what the DSH host actually has: a remembered id that the
 * host can no longer resolve is worse than a fresh start, because the room would
 * silently keep talking into a void.
 * @param options - decision inputs.
 * @param options.remembered - the id from a previous run, if any.
 * @param options.resumable - whether the host resolved that id to a session.
 * @returns the action to take.
 */
export function decideSession({ remembered, resumable }) {
  if (typeof remembered === "string" && remembered.length > 0 && resumable) {
    return { action: "resume", sessionId: remembered };
  }
  return { action: "create", sessionId: undefined, forgot: typeof remembered === "string" && remembered.length > 0 };
}

/**
 * The live agent this driver may adopt for a remembered session, if any.
 *
 * A session has at most one live agent per host process, and whichever view
 * resumed it first owns its single write handle. When that view is the Web GUI,
 * reopening the session would fail with "already owned by an active write
 * handle" for as long as the human keeps it open — so the driver adopts the live
 * agent instead, sharing one agent/loop with the GUI. A session already bound to
 * a *different* room driver is not adoptable: one session serves one room.
 * @param options - decision inputs.
 * @param options.remembered - the session id from the book, if any.
 * @param options.live - the live agent for that id, if any.
 * @param options.owner - the driver currently bound to that id, if any.
 * @param options.self - the driver asking.
 * @returns the live agent to adopt, or `undefined`.
 */
export function adoptableLiveAgent({ remembered, live, owner, self }) {
  if (typeof remembered !== "string" || remembered.length === 0) return undefined;
  if (live === undefined || live === null) return undefined;
  if (owner !== undefined && owner !== self) return undefined;
  return live;
}

/**
 * The driver's persisted state: room → session, plus the last-turn clock used for
 * digest and rate decisions.
 */
export class SessionBook {
  #store;

  /**
   * @param options - book options.
   * @param options.store - the local store that owns the file.
   */
  constructor({ store }) {
    this.#store = store;
  }

  /**
   * Load the book.
   * @param options - load options.
   * @param options.store - an already loaded {@link module:dsh-lobby-bot/local-store.LocalStore}.
   * @returns the book.
   */
  static async load({ store }) {
    return new SessionBook({ store });
  }

  /**
   * The remembered session for one bot in one room.
   *
   * The host resolves this id before using it, so a remembered session that no
   * longer exists is handled by {@link decideSession} rather than here.
   * @param botId - bot id.
   * @param roomId - room id.
   * @returns the session id, or `undefined`.
   */
  get(botId, roomId) {
    const entry = this.#store.getSession(botId, roomId);
    return typeof entry?.sessionId === "string" && entry.sessionId.length > 0 ? entry.sessionId : undefined;
  }

  /** When this bot's last turn in this room started. */
  lastTurnAt(botId, roomId) {
    return this.#store.getSession(botId, roomId)?.lastTurnAt;
  }

  /**
   * Remember one session and/or turn time, then persist.
   * @param options - update inputs.
   * @param options.botId - bot id.
   * @param options.roomId - room id.
   * @param options.sessionId - session to record.
   * @param options.lastTurnAt - turn start time to record.
   */
  async record({ botId, roomId, sessionId, lastTurnAt }) {
    await this.#store.recordSession({ botId, roomId, sessionId, lastTurnAt });
  }
}

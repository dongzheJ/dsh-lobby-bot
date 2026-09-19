/**
 * Where this DSH host keeps what it needs between restarts: the login it used to
 * reach a lobby, and the sessions its bots are talking through.
 *
 * Both used to live inside the lobby checkout (`<lobbyRoot>/data/…`), which only
 * worked because the driver and the lobby happened to be the same machine. After
 * `/lobby <url> <token>` a driver may be anywhere, so the only durable place
 * it can call its own is the harness home — the same `$DSH_HOME` the host already
 * uses for sessions and storages.
 *
 * A personal token is a live secret: the file is written `0600` through a temporary
 * sibling and a rename, so a crash never leaves a half-written token behind.
 * @module dsh-lobby-bot/local-store
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Current on-disk format version. */
export const STORE_VERSION = 1;

/**
 * The harness home of this host.
 *
 * Mirrors the lobby's own rule (`src/dsh-paths.mjs`): `DSH_HOME` when set, else
 * the Desktop app's default. Copied rather than imported because this package is
 * installed into a DSH profile and must not reach back into the chat-room
 * checkout it came from — the two sides are only required to agree on the
 * protocol, not to share a filesystem.
 * @returns absolute path.
 */
export function dshHome() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === "string" && configured.length > 0) return configured;
  return path.join(homedir(), "Library/Application Support/dsh-desktop/harness");
}

/** Absolute path of the login file. */
export function loginPath() {
  return path.join(dshHome(), "lobby-login.json");
}

/**
 * Normalize a lobby address a human typed.
 *
 * `/lobby 192.168.1.9:8770 <token>` is what people actually type, so a bare
 * host gets `http://`, and a trailing slash is dropped so path joins stay sane.
 * @param value - the raw argument.
 * @returns the normalized base URL, or `undefined` when it is unusable.
 */
export function normalizeLobbyUrl(value) {
  const raw = String(value ?? "").trim();
  if (raw.length === 0) return undefined;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.hostname.length === 0) return undefined;
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${pathname}`;
}

/** Whether an address points at this machine's loopback interface. */
export function isLoopbackUrl(value) {
  try {
    const host = new URL(value).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * One JSON document in the harness home, read and written as a whole.
 */
class HomeDocument {
  #file;
  #cache;
  #writing = Promise.resolve();

  /**
   * @param options - document options.
   * @param options.file - absolute path.
   */
  constructor({ file }) {
    this.#file = file;
  }

  /** Absolute path of the document. */
  get file() {
    return this.#file;
  }

  /**
   * Read the document, tolerating absence and corruption.
   * @returns the parsed object (empty when absent).
   */
  async read() {
    if (this.#cache !== undefined) return this.#cache;
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8"));
      this.#cache = parsed !== null && typeof parsed === "object" ? parsed : {};
    } catch {
      // A token file that cannot be parsed is not worth failing a host start over:
      // treat it as "not logged in" and let the human log in again.
      this.#cache = {};
    }
    return this.#cache;
  }

  /**
   * Replace the document.
   *
   * Writes are serialized: two turns that start in the same instant each do a
   * read-modify-write on the shared `#data`, and letting them interleave would
   * lose one bot's bookkeeping. The returned promise is the one to await; the
   * internal chain swallows rejections so a failed write never surfaces as an
   * unhandled rejection on a later, unrelated write.
   * @param value - JSON-serializable value.
   */
  async write(value) {
    this.#cache = value;
    const run = this.#writing.then(() => this.#writeNow(value));
    this.#writing = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** One serialized write: temp file, fsync, atomic rename, mode fix. */
  async #writeNow(value) {
    await mkdir(path.dirname(this.#file), { recursive: true });
    // The temporary name must be unique per write, not merely per process. Two
    // concurrent writes sharing `<file>.<pid>.tmp` race on the rename: the first
    // moves the temp file away, the second gets ENOENT — and an unhandled
    // rejection here used to take the whole DSH host down.
    const temporary = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.#file);
    await chmod(this.#file, 0o600).catch(() => {});
  }

  /** Delete the document. */
  async remove() {
    this.#cache = {};
    await unlink(this.#file).catch(() => {});
  }
}

/**
 * The lobby this host has logged into, and the bots' session book.
 *
 * One file, two sections: `login` is the personal token and must never be logged or
 * echoed, `sessions` is bookkeeping and is safe to show a human.
 */
export class LocalStore {
  #document;
  #data;

  /**
   * @param options - store options.
   * @param options.file - absolute path of the store file.
   * @param options.initial - preloaded contents.
   */
  constructor({ file, initial }) {
    this.#document = new HomeDocument({ file });
    this.#data = initial ?? { version: STORE_VERSION, login: null, sessions: {} };
    this.#data.sessions ??= {};
  }

  /** Load the store from disk. */
  static async load() {
    const document = new HomeDocument({ file: loginPath() });
    const initial = await document.read();
    const store = new LocalStore({ file: loginPath(), initial });
    return store;
  }

  /** Absolute path of the store file. */
  get file() {
    return this.#document.file;
  }

  /** The login, or `null` when this host has not logged in. */
  get login() {
    const login = this.#data.login;
    if (login === null || login === undefined) return null;
    if (typeof login.token !== "string" || login.token.length === 0) return null;
    if (typeof login.url !== "string" || login.url.length === 0) return null;
    return login;
  }

  /**
   * Remember a successful login.
  * @param value - `{url, nick, userId, driverId, token, lobby}`.
   */
  async setLogin(value) {
    this.#data.version = STORE_VERSION;
    this.#data.login = { ...value, savedAt: new Date().toISOString() };
    await this.#document.write(this.#data);
  }

  /** Forget the login. Sessions are kept: they are history, not an identity secret. */
  async clearLogin() {
    this.#data.login = null;
    await this.#document.write(this.#data);
  }

  /** The session book entry for one bot in one room. */
  getSession(botId, roomId) {
    return this.#data.sessions?.[`${botId}/${roomId}`];
  }

  /** Record one bot's session and/or turn time. */
  async recordSession({ botId, roomId, sessionId, lastTurnAt }) {
    const key = `${botId}/${roomId}`;
    const entry = (this.#data.sessions[key] ??= {});
    if (sessionId !== undefined) entry.sessionId = sessionId;
    if (lastTurnAt !== undefined) entry.lastTurnAt = lastTurnAt;
    await this.#document.write(this.#data);
  }

  /** The raw document, for diagnostics. */
  snapshot() {
    return structuredClone(this.#data);
  }
}

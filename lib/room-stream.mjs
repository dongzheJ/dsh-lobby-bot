/**
 * The driver's ear: the lobby's bot gateway stream, one per (bot, room).
 *
 * This is the only channel a DSH-driven bot has for room traffic, so the stream
 * is written to be boringly resilient: it reconnects on any failure with backoff,
 * resumes from the last event id the lobby gave it, and never throws into the
 * host's plugin tree — a dead room must not take the DSH GUI down with it.
 * @module dsh-lobby-bot/room-stream
 */

/**
 * Incremental SSE frame parser.
 *
 * Kept separate from the transport so the framing rules (multi-line `data:`,
 * comments, an event split across TCP chunks) can be tested without a socket.
 */
export class SseParser {
  #buffer = "";

  /**
   * Feed raw bytes and take whatever complete frames they completed.
   * @param chunk - decoded text.
   * @returns complete frames, `{event, data, id}`.
   */
  push(chunk) {
    this.#buffer += chunk;
    const frames = [];
    for (;;) {
      const split = this.#buffer.indexOf("\n\n");
      if (split === -1) break;
      const raw = this.#buffer.slice(0, split);
      this.#buffer = this.#buffer.slice(split + 2);
      const frame = SseParser.parseFrame(raw);
      if (frame !== undefined) frames.push(frame);
    }
    return frames;
  }

  /**
   * Parse one frame block.
   * @param raw - the block without its trailing blank line.
   * @returns the frame, or `undefined` for comments and keep-alives.
   */
  static parseFrame(raw) {
    let event = "message";
    let id;
    const data = [];
    for (const line of raw.split("\n")) {
      if (line.length === 0 || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      else if (field === "id") id = value;
    }
    if (data.length === 0) return undefined;
    const joined = data.join("\n");
    let parsed;
    try {
      parsed = JSON.parse(joined);
    } catch {
      parsed = joined;
    }
    return { event, data: parsed, id };
  }
}

/**
 * One reconnecting subscription to a room.
 */
export class RoomStream {
  #options;
  #controller;
  #stopped = false;
  #lastEventId;
  #attempt = 0;

  /**
   * @param options - stream options.
   * @param options.baseUrl - the lobby's loopback base URL.
  * @param options.botId - the bot whose gateway is used.
   * @param options.roomId - the room to follow.
  * @param options.token - the user's personal token.
   * @param options.onEvent - called with `{event, data, id}` for every frame.
   * @param options.logger - a `{info, warn, error}` sink.
   * @param options.fetchImpl - injectable fetch, for tests.
   */
  constructor({ baseUrl, botId, roomId, token, onEvent, logger, fetchImpl = fetch }) {
    this.#options = { baseUrl, botId, roomId, token, onEvent, logger, fetchImpl };
  }

  /** The last event id this stream has seen, used to resume after a gap. */
  get lastEventId() {
    return this.#lastEventId;
  }

  /** Open the stream and keep it open until {@link stop}. */
  async start() {
    this.#stopped = false;
    while (!this.#stopped) {
      try {
        await this.#pump();
        this.#attempt = 0;
      } catch (error) {
        if (this.#stopped) return;
        this.#attempt += 1;
        const delay = Math.min(1000 * 2 ** (this.#attempt - 1), 30_000);
        this.#options.logger?.warn?.(
          `lobby-bot: ${this.#options.botId}/${this.#options.roomId} 流断开（${String(error?.message ?? error)}），${Math.round(delay / 1000)}s 后重连`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /** Close the stream; the pump loop exits on its next iteration. */
  stop() {
    this.#stopped = true;
    this.#controller?.abort();
  }

  /** One connection: read frames until the socket ends or throws. */
  async #pump() {
    const { baseUrl, botId, roomId, token, onEvent, fetchImpl } = this.#options;
    this.#controller = new AbortController();
    const url = new URL(`/api/bot/${botId}/stream`, baseUrl);
    url.searchParams.set("roomId", roomId);
    const headers = { Authorization: `Bearer ${token}`, Accept: "text/event-stream" };
    if (this.#lastEventId !== undefined) headers["Last-Event-ID"] = String(this.#lastEventId);
    const response = await fetchImpl(url, { headers, signal: this.#controller.signal });
    if (!response.ok) throw new Error(`stream HTTP ${response.status}`);
    const parser = new SseParser();
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      if (this.#stopped) return;
      for (const frame of parser.push(decoder.decode(chunk, { stream: true }))) {
        if (frame.id !== undefined) this.#lastEventId = frame.id;
        onEvent(frame);
      }
    }
  }
}

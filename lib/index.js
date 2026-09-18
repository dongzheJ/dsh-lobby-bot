/**
 * dsh-lobby-bot — 让聊天室（Lobby）驱动 DSH 自己的会话。
 *
 * 房间里的 `@小运` 由这个插件接住，然后由 **DSH 宿主自己**创建/恢复会话、投喂 prompt、
 * 收集回复并发回房间。于是：
 *
 * - 会话是宿主进程里的活会话：GUI 里实时长出来，不需要刷新；
 * - 会话通过 `workspaceRegistry.create()` + `attachSession()` 归到 bot 自己的工作区下；
 * - 整条会话只有宿主一个写者，不再有"两个进程同写一条日志"的坑。
 *
 * 房间与插件之间**只用 lobby 已有的 bot 网关**（`/api/bot/:id/stream|messages|typing|status`），
 * 不引入私有接口。配置只读 lobby 自己的 `config/`，保证两边对同一个 bot 的理解完全一致。
 *
 * 关于被让渡的能力（见仓库 README 的"两种驱动"一节）：审批改由权限预设 `never` 处理，
 * 没有退避重启（DSH 不在 = bot 不在），`toolAllow` 在本版本不生效。
 * @module dsh-lobby-bot
 */
import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { LOBBY_HELP, parseLobbyCommand } from "./command-input.mjs";
import { describeHolder, heartbeatLock } from "./lock.mjs";
import { dshHome, LocalStore, normalizeLobbyUrl } from "./local-store.mjs";
import { buildDigest, formatPrompt, sessionTitle } from "./prompt.mjs";
import { emptyRoster, fetchRoster } from "./roster.mjs";
import { diffRoster, expandRoster, fingerprintOf, pairKey } from "./roster-diff.mjs";
import { RoomStream } from "./room-stream.mjs";
import { adoptableLiveAgent, decideSession, SessionBook } from "./session-book.mjs";
import { botChainLength, shouldTrigger, TurnQueue } from "./turn-policy.mjs";

/** Idle time after which the next turn re-injects a room digest. */
const DIGEST_AFTER_IDLE_MS = 10 * 60 * 1000;

/** How many room messages are kept for digest building. */
const WINDOW_MESSAGES = 60;

/** How often a driven bot re-reports that it is alive (the report is a heartbeat). */
const HEARTBEAT_MS = 30_000;

/**
 * How often the driver re-reads the roster.
 *
 * The roster changes from outside this process (`/lobby <url> <token>` writes a bot config
 * through the lobby's API, and a person may edit `config/bots/*.json`), so the
 * driver has to notice rather than requiring a host restart.
 */
const ROSTER_REFRESH_MS = 30_000;

/**
 * How often a non-driving host retries the driver lock.
 *
 * Host restarts are normal (DSH Desktop restart), and a dead host cannot release
 * its lock: the new one must therefore keep asking instead of idling forever.
 */
const LOCK_RETRY_MS = 20_000;

/**
 * How often a host whose pre-filled login failed retries it.
 *
 * The lobby can simply be slower to start than the host (launchd, a machine that
 * just booted, a lobby being restarted), and "host started first" must not leave
 * the host logged out until somebody restarts the GUI.
 */
const LOGIN_RETRY_MS = 30_000;

/** Cordis plugin name. */
export const name = "dsh-lobby-bot";

/**
 * Driver protocol version reported at login.
 *
 * The lobby refuses a driver it cannot speak to (and says so) rather than letting
 * a half-understood protocol produce a room that silently stops answering.
 */
export const DRIVER_VERSION = 1;

/**
 * Services this plugin cannot work without.
 *
 * Only `commands` is a hard dependency: registering the command family is the one
 * thing that must happen, and it is what makes `/lobby` appear in the GUI's slash
 * menu (the client discovers commands per agent at runtime).
 *
 * The agent-facing services (`agents`, `workspaceRegistry`, `agentPresets`) are
 * looked up when a turn actually runs, not up front. Declaring them here made the
 * whole plugin wait forever on a host that does not mount them — the command line
 * vanished, and nothing was logged, because Cordis simply never called `apply()`.
 * A missing service must cost one turn with a clear message, not the command
 * surface itself.
 */
export const inject = ["commands"];

/** Read the driver's own options, tolerating an empty row config. */
function readConfig(config) {
  return {
    // 登录用的预填值：给了 url 与 token 就在启动时自动登录一次，
    // 但**不再有 lobbyRoot**——插件不再读本机 lobby 仓库的配置文件，
    // 名册、建房、驱动锁全部走 HTTP。
    url: typeof config?.url === "string" && config.url.trim().length > 0 ? config.url.trim() : null,
    token: typeof config?.token === "string" && config.token.length > 0 ? config.token : null,
    permissionPresets: Array.isArray(config?.permissionPresets) && config.permissionPresets.length > 0
      ? config.permissionPresets.map(String)
      : ["lobby-bot-workspace", "danger-full-access"],
    digestIdleMs: Number.isInteger(config?.digestIdleMs) ? config.digestIdleMs : DIGEST_AFTER_IDLE_MS,
  };
}

/** A logger that never breaks the host when a level is missing. */
function loggerOf(ctx) {
  const target = ctx.logger ?? {};
  return {
    info: (message) => target.info?.(message),
    warn: (message) => target.warn?.(message),
    error: (message) => target.error?.(message),
  };
}

/**
 * One bot's presence in one room: its stream, its queue, its session.
 */
class RoomDriver {
  /** 影响本流行为参数指纹；roster 差分用它判断"要不要重开流"。 */
  fingerprint = "";
  #hub;
  #bot;
  #room;
  #queue;
  #window = [];
  #stream;
  #streamTask;
  #handle;
  /** The in-flight attach, shared by every turn that reaches {@link #ensureSession} at once. */
  #pendingSession;
  #collector;
  #lastPromptAt;
  #primed = false;
  #digestAt = 0;
  /** 上一次预占失败是否已经报过，避免每 30 秒刷一条同样的日志。 */
  #warmReported = false;
  /** 本驱动是否只是"采纳"了别人（GUI/宿主）的 live agent，而不是自己开的。 */
  #adopted = false;

  /**
   * @param options - driver inputs.
   * @param options.hub - the owning hub.
   * @param options.bot - bot record from the roster.
   * @param options.room - room record from the roster.
   */
  constructor({ hub, bot, room }) {
    this.#hub = hub;
    this.#bot = bot;
    this.#room = room;
    this.#queue = new TurnQueue({ limit: bot.queueLimit });
  }

  /** The bot this driver speaks for. */
  get bot() {
    return this.#bot;
  }

  /** The room it speaks in. */
  get room() {
    return this.#room;
  }

  /** Open the room stream and keep it open. */
  start() {
    this.#stream = new RoomStream({
      baseUrl: this.#hub.baseUrl,
      botId: this.#bot.id,
      roomId: this.#room.id,
      token: this.#hub.token,
      logger: this.#hub.logger,
      onEvent: (frame) => this.onEvent(frame),
    });
    this.#streamTask = this.#stream.start().catch((error) => {
      this.#hub.logger.error(`lobby-bot: ${this.#bot.id}/${this.#room.id} 流意外退出：${String(error?.message ?? error)}`);
    });
  }

  /**
   * Take this room's session now instead of waiting for the first turn that needs it.
   *
   * A session has exactly one writer, and this host is not the only thing that opens
   * one: the Web GUI resumes whatever session a paired browser is looking at and
   * keeps it live. Attaching lazily lost that race after every restart — the GUI
   * re-opened the bot's own session first, and the bot then answered every mention
   * with "already owned by an active write handle" for as long as the browser kept
   * it open. Attaching as soon as this driver is running, and retrying on every
   * roster refresh, means the bot claims its session first when it can and recovers
   * by itself within one refresh after the GUI lets go.
   *
   * Idempotent and silent on success: a driver that already holds its session (or is
   * already attaching) does nothing, and a failure is reported once, not every round.
   */
  warm() {
    if (this.#pendingSession !== undefined) return;
    if (this.#handle !== undefined) {
      if (this.#handleIsLive()) return;
      // An adopted handle can be torn down by its real owner (the GUI) at any
      // time; forget it so the next attempt can take the session as the writer.
      this.#forgetDeadHandle();
    }
    void this.#ensureSession().then(
      () => {
        this.#warmReported = false;
      },
      (error) => {
        if (this.#warmReported) return;
        this.#warmReported = true;
        this.#hub.logger.warn(
          `lobby-bot: ${this.#bot.id}/${this.#room.id} 暂时拿不到会话（每轮 roster 会再试）：${String(error?.message ?? error)}`,
        );
      },
    );
  }

  /**
   * Whether the cached handle may still be used.
   *
   * A handle this driver created is its own for its whole life. An *adopted*
   * handle is only a loan: the GUI (or whichever view resumed the session)
   * owns it and can dispose it at any moment, after which the agent object is
   * stale and prompting it is a mistake.
   * @returns `true` when the cached handle is still live.
   */
  #handleIsLive() {
    const handle = this.#handle;
    if (handle === undefined) return false;
    if (!this.#adopted) return true;
    const sessionId = handle.agent?.session?.id;
    return typeof sessionId === "string" && this.#hub.liveAgent(sessionId) === handle.agent;
  }

  /** Forget a cached adopted handle whose owner has since disposed the agent. */
  #forgetDeadHandle() {
    const handle = this.#handle;
    if (handle === undefined || !this.#adopted) return;
    const sessionId = handle.agent?.session?.id;
    if (typeof sessionId === "string") this.#hub.unregister(sessionId, this);
    this.#handle = undefined;
    this.#adopted = false;
  }

  /**
   * Stop the stream, hand the session back, and abandon queued work.
   *
   * Disposing the handle is not optional tidiness: the handle is an owned
   * capability, and its write handle on the session log stays open until it is
   * disposed. A driver that is torn down without disposing — which is what a
   * roster change does — leaves that lock behind, and the next driver assigned
   * to the same bot and room is refused when it tries to resume the remembered
   * session ("already owned by an active write handle"). So `stop()` is "give
   * the session back", not merely "detach the stream".
   */
  async stop() {
    this.#stream?.stop();
    this.#queue.clear();
    await this.#streamTask?.catch(() => {});
    const handle = this.#handle;
    this.#handle = undefined;
    // A later turn may re-attach; the cached attempt must not outlive the handle.
    this.#pendingSession = undefined;
    // An adopted handle's dispose is a no-op, so the real owner keeps its agent.
    this.#adopted = false;
    if (handle === undefined) return;
    try {
      await handle.dispose?.();
    } catch (error) {
      this.#hub.logger.warn(
        `lobby-bot: ${this.#bot.id}/${this.#room.id} 会话句柄释放失败：${String(error?.message ?? error)}`,
      );
    }
  }

  /**
   * Handle one gateway frame.
   * @param frame - `{event, data}` from the room stream.
   */
  onEvent({ event, data }) {
    if (event === "cancel") {
      this.cancel("room /stop");
      return;
    }
    if (event !== "message" && event !== "mention" && event !== "mention_replay") return;
    if (data === undefined || data === null || typeof data !== "object") return;
    if (data.kind !== "system") {
      // The gateway sends a mentioned message twice: once as `message` and once
      // as `mention`. They share the same room sequence number, so the trigger
      // event must not add a second copy to the history window.
      const alreadyRemembered = Number.isInteger(data.seq)
        && this.#window.some((message) => message.seq === data.seq);
      if (!alreadyRemembered) {
        this.#window.push(data);
        if (this.#window.length > WINDOW_MESSAGES) this.#window.shift();
      }
    }
    // `mention_replay` is a mention the lobby replayed when this stream opened:
    // it was addressed to the bot before the driver was listening. It must be
    // answered only when this room has no turn yet — otherwise every restart
    // would answer the room's whole mention history. A live `mention` is never
    // gated this way: a person who names the bot is always answered.
    if (event === "mention_replay" && !this.#isFirstTurn()) return;
    const now = Date.now();
    // The window ends with this message and skips system lines, so this is the
    // same count the lobby computes from the authoritative transcript.
    const botChain = botChainLength(this.#window);
    const triggerEvent = event === "mention_replay" ? "mention" : event;
    if (!shouldTrigger({ bot: this.#bot, event: triggerEvent, message: data, lastTurnAt: this.#lastPromptAt, botChain, now })) return;
    const verdict = this.#queue.push(data);
    if (verdict === "run") void this.#runTurn([data]);
    else if (verdict === "merged") {
      this.#hub.logger.info(`lobby-bot: ${this.#bot.id}/${this.#room.id} 忙，已合并 ${this.#queue.merged} 条待回复消息`);
    }
  }

  /**
   * Whether this driver has never taken a turn in this room.
   *
   * Used to gate `mention_replay`: the replayed mention is worth answering only
   * when it is genuinely new work (a bot just added to a room, mentioned before
   * its stream opened), not history a previous run already handled. The in-memory
   * clock covers a burst of replays within one connection; the persisted one
   * covers a restart.
   * @returns `true` when no turn has run here yet.
   */
  #isFirstTurn() {
    if (this.#lastPromptAt !== undefined) return false;
    return this.#hub.book.lastTurnAt(this.#bot.id, this.#room.id) === undefined;
  }

  /**
   * Ask the active turn to stop, and abandon whatever queued behind it.
   *
   * The room's stop means the backlog too — the lobby's own driver does the same
   * (`room.pending = []` in `src/bot-supervisor.mjs`), and a stop that only
   * cancels the turn in flight leaves the room answering a conversation the human
   * already ended. The queue is cleared even when no turn is in flight, which is
   * exactly the case where the old early return made `/stop` a no-op.
   * @param cause - why (recorded in the trajectory by the host).
   */
  cancel(cause) {
    const dropped = this.#queue.size;
    this.#queue.clear();
    if (dropped > 0) {
      this.#hub.logger.info(`lobby-bot: ${this.#bot.id}/${this.#room.id} 收到停止，已丢弃 ${dropped} 个排队回合`);
    }
    const collector = this.#collector;
    if (collector === undefined) return;
    collector.cancelled = true;
    this.#handle?.agent.cancel(cause);
    collector.finish();
  }

  /**
   * One turn: prompt the bot's session, post what it said.
   *
   * A turn that yields no text still leaves a room-visible note, but only for a
   * human trigger — see the `waitingHuman` note below.
   */
  async #runTurn(triggers) {
    const bot = this.#bot;
    const roomId = this.#room.id;
    this.#lastPromptAt = Date.now();
    await this.#hub.book.record({ botId: bot.id, roomId, lastTurnAt: this.#lastPromptAt });
    await this.#hub.postTyping(this, true);
    try {
      const handle = await this.#ensureSession();
      if (handle === undefined) {
        await this.#hub.postMessage(this, "（我这轮没能开工：DSH 侧没有可用的会话）");
        return;
      }
      // A fresh session (and a session idle for a long while) needs the room's
      // recent history; an established one does not, and re-sending it every turn
      // would burn context for nothing.
      const idle = this.#lastPromptAt - this.#digestAt > this.#hub.digestIdleMs;
      const includeDigest = !this.#primed || idle;
      const prompt = formatPrompt({
        bot,
        roomId,
        roomName: this.#room.name,
        triggers,
        digest: buildDigest({ messages: this.#window, botId: bot.id, exclude: triggers, ...bot.contextDigest }),
        includeDigest,
      });
      const collected = await this.#prompt(handle, prompt);
      this.#primed = true;
      this.#digestAt = Date.now();
      const body = collected.texts.join("\n\n").trim();
      // A turn that produced nothing the room can read is worth a line only when a
      // person is waiting for it. When another bot triggered the turn, the honest
      // place for "the model said nothing" is the host log: posting it would turn
      // every internal no-op into room traffic, which is how a stalled cascade
      // looked like four bots talking to nobody.
      const waitingHuman = triggers.some((trigger) => trigger?.kind === "human");
      const placeholder = collected.timedOut
        ? `（这轮超时了（${Math.round(bot.promptTimeoutMs / 1000)}s），已取消）`
        : collected.cancelled
          ? "（这轮已被取消）"
          : "（这轮没有产出内容）";
      if (body.length > 0) await this.#hub.postMessage(this, body);
      else if (waitingHuman) await this.#hub.postMessage(this, placeholder);
      else {
        this.#hub.logger.warn(
          `lobby-bot: ${bot.id}/${roomId} ${placeholder.slice(1, -1)}（触发来自房间里的 bot，不在房内播报）`,
        );
      }
    } catch (error) {
      const reason = String(error?.message ?? error);
      this.#hub.logger.error(`lobby-bot: ${bot.id}/${roomId} 回合失败：${reason}`);
      // One contention has a cause the room can act on, and the harness wording
      // names neither the session nor the likely holder. A session is
      // single-writer, and an open Web GUI session is a writer like any other —
      // so say that instead of pasting "already owned by an active write handle".
      const contended = reason.includes("is already owned by an active write handle");
      const held = contended ? this.#hub.book.get(bot.id, roomId) : undefined;
      await this.#hub.postMessage(
        this,
        contended
          ? `（我这轮开不了工：会话 ${String(held ?? "?").slice(0, 8)} 的写入锁在别的 DSH 客户端手里——最常见是 Web GUI 里正开着这个会话。请在 GUI 里切走或关掉它，我下一轮就能接手。）`
          : `（我这轮失败了：${reason}）`,
      );
    } finally {
      await this.#hub.postTyping(this, false);
      const next = this.#queue.next();
      if (next !== undefined) void this.#runTurn(next);
    }
  }

  /**
   * Prompt the session and collect what the model produced.
   * @param handle - the live agent handle.
   * @param text - the framed room prompt.
   * @returns the collected assistant text plus how the turn ended.
   */
  async #prompt(handle, text) {
    const collector = { texts: [], cancelled: false, timedOut: false, finish: () => {} };
    const finished = new Promise((resolve) => {
      collector.finish = resolve;
    });
    this.#collector = collector;
    this.#handle = handle;
    const timer = setTimeout(() => {
      collector.timedOut = true;
      handle.agent.cancel("lobby prompt timeout");
      collector.finish();
    }, this.#bot.promptTimeoutMs);
    try {
      handle.agent.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }));
      await finished;
    } finally {
      clearTimeout(timer);
      this.#collector = undefined;
    }
    return collector;
  }

  /**
   * Feed one session event into the active collector.
   * @param event - a raw session event.
   */
  onSessionEvent(event) {
    const collector = this.#collector;
    if (collector === undefined) return;
    if (event?.type === "assistant/message") {
      const content = event.data?.message?.content;
      if (Array.isArray(content)) {
        const text = content
          .filter((block) => block?.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("");
        if (text.trim().length > 0) collector.texts.push(text);
      }
      return;
    }
    if (event?.type === "turn/end") collector.finish();
  }

  /**
   * Resolve this room's session, adopting the previous one when it still exists.
   *
   * Adoption is what makes switching a bot from `driver: "local"` to `driver: "dsh"`
   * keep its memory: the ids recorded by the lobby are resumed in the host.
   * @returns the live agent handle, or `undefined` when the session cannot be prepared.
   */
  async #ensureSession() {
    if (this.#handle !== undefined) {
      if (this.#handleIsLive()) return this.#handle;
      this.#forgetDeadHandle();
    }
    // Two turns can reach here in the same tick — a burst of mentions, or a
    // queued turn racing a fresh one. Attaching twice opens two write handles
    // for one session log and the host refuses the second, which is the
    // "already owned by an active write handle" failure. Caching the *attempt*
    // rather than only its result is what makes both callers share one attach.
    this.#pendingSession ??= this.#attachSession();
    try {
      return await this.#pendingSession;
    } catch (error) {
      // A failed attach must not be cached, or the bot could never retry.
      this.#pendingSession = undefined;
      throw error;
    }
  }

  /**
   * Open (or adopt) this room's session. Reachable only through {@link #ensureSession}.
   * @returns the live agent handle, or `undefined` when the session cannot be prepared.
   */
  async #attachSession() {
    const hub = this.#hub;
    const bot = this.#bot;
    const roomId = this.#room.id;
    const remembered = hub.book.get(bot.id, roomId);

    // A live agent for this session already exists in this host process: the
    // Web GUI (or another view) resumed it and owns its single write handle, so
    // reopening the session here would fail with "already owned by an active
    // write handle" for as long as the human keeps it open. Adopt the live
    // agent instead — the same choice the host's session-controller makes in
    // `createOrAdopt` — so the session stays both watchable in the GUI and
    // drivable by the bot. The handle is a loan: its `dispose` is a no-op, and
    // {@link RoomDriver#stop} must never tear down an agent this driver did not
    // create. Checked before the workspace is touched, because adoption needs
    // no workspace at all.
    if (typeof remembered === "string" && remembered.length > 0) {
      const live = adoptableLiveAgent({
        remembered,
        live: hub.liveAgent(remembered),
        owner: hub.driverForSession(remembered),
        self: this,
      });
      if (live !== undefined) {
        this.#adopted = true;
        await hub.book.record({ botId: bot.id, roomId, sessionId: remembered });
        hub.register(remembered, this);
        this.#handle = { agent: live, dispose: async () => {} };
        hub.logger.info(
          `lobby-bot: ${bot.id}/${roomId} 采纳已在线会话 ${String(remembered).slice(0, 8)}（写锁在 GUI/宿主手里，共用同一 agent）`,
        );
        return this.#handle;
      }
    }

    // The registry canonicalizes through realpath and refuses a path that is not
    // there yet, so the directory is created first — the same thing the create
    // branch used to do further down, and now also what keeps an eager
    // {@link RoomDriver.warm} from depending on when the workspace was prepared.
    await mkdir(bot.workspace, { recursive: true });
    const workspace = await hub.service("workspaceRegistry").create(bot.workspace);

    let resumable = false;
    let storedPreset;
    if (typeof remembered === "string" && remembered.length > 0) {
      const observation = await hub.observe(remembered);
      if (observation !== undefined) {
        // The registry itself compares canonical paths, so the driver must too:
        // a session recorded under a pre-migration path still belongs here when
        // that path resolves to this workspace.
        const recordedCwd = observation.header?.cwd;
        resumable = typeof recordedCwd === "string" && await sameDirectory(recordedCwd, workspace.path);
        storedPreset = observation.projections?.values?.agentPreset;
      }
    }
    let decision = decideSession({ remembered, resumable });
    if (decision.action === "resume") {
      // 一条会话只能服务一个房间：把当前会话接给某个房间之后，
      // 若它又出现在另一个房间的账本里，就必须另建，否则两个房间的回覆会串台。
      const owner = hub.driverForSession(decision.sessionId);
      if (owner !== undefined && owner !== this) {
        hub.logger.warn(`lobby-bot: ${bot.id}/${roomId} 记着的会话 ${String(decision.sessionId).slice(0, 8)} 已被别的房间占用，改新建`);
        decision = { action: "create", sessionId: undefined, forgot: false };
      }
    }
    if (decision.forgot === true) {
      hub.logger.warn(`lobby-bot: ${bot.id}/${roomId} 原会话 ${remembered} 已不可用，将新建会话`);
      await hub.postMessage(this, `（原来的会话 ${String(remembered).slice(0, 8)} 在 DSH 侧找不到了，这轮开始是新会话）`);
    }

    const presets = hub.ctx.get?.("agentPresets") ?? hub.ctx.agentPresets;
    const composition = presets === undefined
      ? { agentPreset: undefined, setup: undefined }
      : await hub.composition(presets, decision.action === "resume" ? storedPreset : undefined);

    let handle;
    if (decision.action === "resume") {
      handle = await hub.service("agents").resume({
        resumeSessionId: remembered,
        ...(hub.agentOptions === undefined ? {} : { agentOptions: hub.agentOptions }),
        ...(composition.setup === undefined ? {} : { setup: composition.setup }),
      });
    } else {
      await mkdir(workspace.path, { recursive: true });
      handle = await hub.service("agents").create({
        sessionId: `lobby-${randomUUID()}`,
        ...(hub.agentOptions === undefined ? {} : { agentOptions: hub.agentOptions }),
        meta: {
          cwd: workspace.path,
          ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
        },
        ...(composition.setup === undefined ? {} : { setup: composition.setup }),
      });
    }

    const sessionId = handle.agent.session.id;
    // Everything below can fail, and the handle is already an owned capability by
    // this point: it holds the session's write lock. A step that throws here used
    // to leave that lock behind with no driver holding it, so the next turn was
    // refused with "already owned by an active write handle" and the bot could
    // never attach again — the same symptom as `stop()` not disposing, reached by
    // a different route (a failed preset, a failed book write). Give it back.
    try {
      await workspace.attachSession(sessionId);
      hub.applyPreset(handle.agent.session);
      hub.applyTitle(handle.agent.session, bot, this.#room);
      await hub.book.record({ botId: bot.id, roomId, sessionId });
      hub.register(sessionId, this);
    } catch (error) {
      try {
        await handle.dispose?.();
      } catch (disposeError) {
        hub.logger.warn(
          `lobby-bot: ${bot.id}/${roomId} 会话 ${String(sessionId).slice(0, 8)} 建立失败后释放句柄也失败：${String(disposeError?.message ?? disposeError)}`,
        );
      }
      throw error;
    }
    this.#handle = handle;
    hub.logger.info(`lobby-bot: ${bot.id}/${roomId} 会话就绪 ${sessionId}（${decision.action === "resume" ? "采纳" : "新建"}）`);
    return handle;
  }
}

/** Whether two paths resolve to the same directory (the registry's own rule). */
async function sameDirectory(left, right) {
  try {
    return (await realpath(left)) === (await realpath(right));
  } catch {
    return false;
  }
}

/**
 * The hub: personal token, roster, driver lock, session book, and HTTP to the room.
 *
 * Everything it knows about the lobby is fetched with the personal token a human
 * obtained through `/lobby <url> <token>` — the hub never reads the lobby's files. That is
 * the whole point of the login: a driver on another machine has the same amount of
 * information as one on the lobby's own machine, and no more.
 */
class DriverHub {
  #store;
  /** Async status writer used by {@link DriverHub.markStatus}. */
  #statusWriter;
  /** 本机是否持有驱动锁（服务端仲裁的结果）。 */
  #driving = false;
  /** 服务端报告的持有者，用于日志与 `/lobby status`。 */
  lockHolder = null;
  /** key `botId/roomId` → RoomDriver */
  #drivers = new Map();
  #bySession = new Map();
  #heartbeat;
  #refreshTimer;
  #started = false;
  #stopped = false;
  /** `/lobby` 是否注册成功（写进状态文件，便于终端核对）。 */
  commandsRegistered = false;
  startedAt = new Date().toISOString();

  /**
   * @param options - hub inputs.
   * @param options.ctx - the host context.
   * @param options.config - resolved driver config.
   * @param options.store - the local store holding the login and the session book.
   */
  constructor({ ctx, config, store, statusFile }) {
    this.ctx = ctx;
    this.config = config;
    this.#store = store;
    this.#statusWriter = statusFile;
    this.book = new SessionBook({ store });
    this.roster = emptyRoster();
    this.logger = loggerOf(ctx);
    this.digestIdleMs = config.digestIdleMs;
    const selected = ctx.get("agentDefaultModel");
    const botModel = this.roster.bots.find((bot) => bot.model !== null)?.model;
    this.agentOptions = botModel !== null && botModel !== undefined && botModel.model.length > 0
      ? { provider: botModel.provider, model: botModel.model }
      : selected === undefined
        ? undefined
        : { provider: selected.currentSelection().provider, model: selected.currentSelection().model };
    this.#syncModelOptions();
  }

  /**
   * A host service the driver needs at turn time.
   *
   * See the note on `inject`: these are resolved when used, so a host that does not
   * mount them still gets `/lobby status` instead of a plugin that never applies.
   * @param name - service name.
   * @returns the service.
   * @throws when the host does not provide it.
   */
  service(name) {
    const value = this.ctx.get?.(name) ?? this.ctx[name];
    if (value === undefined) throw new Error(`宿主没有提供 ${name} 服务（无法创建会话）`);
    return value;
  }

  /** The current login, or `null` when this host has not logged in. */
  get login() {
    return this.#store.login;
  }

  /** The lobby this hub talks to, or `""` before login. */
  get baseUrl() {
    return this.#store.login?.url ?? "";
  }

  /** The user's personal token, or `""` before login. */
  get token() {
    return this.#store.login?.token ?? "";
  }

  /** Whether this host currently holds the driver lock. */
  get driving() {
    return this.#driving;
  }

  /** The logged-in nickname, or `null`. */
  get ownerNick() {
    return this.#store.login?.nick ?? null;
  }

  /** Absolute path of the file this host remembers its login in. */
  get storeFile() {
    return this.#store.file;
  }

  /**
   * Re-read the model route from the roster.
   *
   * The lobby resolves `model: null` to the profile default, so a roster that
   * names no model keeps whatever the host's own default selection is.
   */
  #syncModelOptions() {
    const selected = this.ctx.get("agentDefaultModel");
    const botModel = this.roster.bots.find((bot) => bot.model !== null && bot.model !== undefined)?.model;
    this.agentOptions = botModel !== undefined && typeof botModel.model === "string" && botModel.model.length > 0
      ? { provider: botModel.provider, model: botModel.model }
      : selected === undefined
        ? undefined
        : { provider: selected.currentSelection().provider, model: selected.currentSelection().model };
  }

  /**
  * Log in to a lobby and remember the personal token.
   *
   * This is the only way this host obtains the right to register a bot: the token
  * is used directly as the Bearer credential for every subsequent request.
   *
   * Named `loginTo` and not `login`: the hub also has a `get login()` for the stored
  * token, and a same-named method on the prototype made `hub.login === null`
   * compare a *function* against null. The auto-login branch in `apply()` was
   * therefore dead code — it read as working, logged nothing, and simply never ran.
   * @param options - login inputs.
   * @param options.url - the lobby address a human typed.
   * @param options.token - the static token the lobby printed at startup.
  * @returns `{ok:true, lobby, nick}` or `{ok:false, message}`.
   */
  async loginTo({ url, token }) {
    const normalized = normalizeLobbyUrl(url);
    if (normalized === undefined) return { ok: false, message: `不是合法的房间服务地址：${url}` };
    let response;
    try {
      response = await fetch(new URL("/api/driver/login", normalized), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ driverVersion: DRIVER_VERSION }),
      });
    } catch (error) {
      return { ok: false, message: `连不上 ${normalized}：${String(error?.message ?? error)}` };
    }
    const text = await response.text();
    let body;
    try {
      body = text.length === 0 ? {} : JSON.parse(text);
    } catch {
      return { ok: false, message: `${normalized} 返回的不是 JSON（HTTP ${response.status}）` };
    }
    if (!response.ok) {
      const hint = body.error === "bad_token" ? "（令牌不对：请输入你的个人 token）" : "";
      return { ok: false, message: `${body.message ?? body.error ?? `HTTP ${response.status}`}${hint}` };
    }
    await this.#store.setLogin({
      url: normalized,
      nick: body.me?.nick ?? "DSH 用户",
      userId: body.me?.id ?? null,
      driverId: body.me?.driverId ?? null,
      token,
      lobby: body.lobby ?? null,
    });
    this.logger.info(`lobby-bot: 已登录 ${normalized}（身份 ${body.me?.nick ?? "?"}）`);
    return { ok: true, lobby: body.lobby ?? null, nick: body.me?.nick ?? null };
  }

  /**
   * Retry a pre-filled login after the lobby turned out to be unreachable.
   *
   * Called on a timer from `apply()` when the row carries `url` + `token` and the
   * first attempt failed. On success it finishes the startup the first attempt could
   * not: verify, take the lock, open streams. Without this, starting DSH before the
   * lobby leaves the host permanently logged out and only a restart fixes it.
   * @param options - the pre-filled login.
   * @param options.url - the lobby address.
   * @param options.token - the static token from the row.
   * @returns whether this host is now logged in.
   */
  async recoverLogin({ url, token }) {
    const result = await this.loginTo({ url, token });
    if (!result.ok) return false;
    this.logger.info(`lobby-bot: 重试登录成功 ${this.baseUrl}`);
    await this.refreshRoster();
    const driving = await this.tryBecomeDriver();
    if (!driving) {
      const retry = setInterval(() => void this.tryBecomeDriver(), LOCK_RETRY_MS);
      retry.unref?.();
    }
    const refresh = setInterval(() => void this.refreshRoster(), ROSTER_REFRESH_MS);
    refresh.unref?.();
    void this.writeStatus();
    return true;
  }

  /**
  * Verify a remembered personal token against the lobby.
   *
   * Called at startup: a lobby that rotated its token, revoked this driver, or
   * simply is not running must leave the host in a state a human can see and fix,
   * not a state that half-works.
   * @returns `{ok:true, lobby}` or `{ok:false, message}`.
   */
  async verifyLogin() {
    const login = this.#store.login;
    if (login === null) return { ok: false, message: "还没有登录" };
    try {
      const response = await fetch(new URL("/api/driver/me", login.url), {
        headers: { Authorization: `Bearer ${login.token}` },
      });
      if (response.status === 401) return { ok: false, message: "凭据已失效（服务端已吊销或换了令牌）" };
      if (!response.ok) return { ok: false, message: `HTTP ${response.status}` };
      const body = await response.json().catch(() => ({}));
      return { ok: true, lobby: body.lobby ?? login.lobby ?? null };
    } catch (error) {
      return { ok: false, message: `连不上 ${login.url}：${String(error?.message ?? error)}` };
    }
  }

  /** Forget the local personal token, and stop driving. */
  async logout({ revoke = true } = {}) {
    const login = this.#store.login;
    if (login !== null && revoke) {
      try {
        await fetch(new URL("/api/driver/logout", login.url), {
          method: "POST",
          headers: { Authorization: `Bearer ${login.token}` },
        });
      } catch {
        // A lobby that cannot be reached still loses this host's token: the
        // human asked to log out, and a stale copy on disk is the bigger risk.
      }
    }
    await this.yieldDriving();
    await this.#store.clearLogin();
    this.roster = emptyRoster();
    this.lockHolder = null;
  }

  /**
   * Compose one agent scope, mirroring what the host's session controller does.
   * @param presets - the agent-preset service.
   * @param presetId - the preset to use (a resumed session's own, or the default).
   * @returns the preset id plus its mount hook.
   */
  async composition(presets, presetId) {
    const resolved = await presets.resolve(presetId);
    return {
      agentPreset: resolved.id,
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, resolved.id);
      },
    };
  }

  /** Look up a persisted session without activating it. */
  async observe(sessionId) {
    const query = this.ctx.get("sessionQuery");
    if (query === undefined) return undefined;
    try {
      const observation = await query.observeSession(sessionId);
      return observation;
    } catch {
      return undefined;
    }
  }

  /**
   * The live agent for a session in this host process, if any.
   *
   * DSH keeps at most one live agent per session in a process; the Web GUI (or
   * another view) that resumed the session owns it and its single write handle.
   * The plugin adopts this agent instead of reopening the session — the same
   * thing the host's own session-controller does in `createOrAdopt` — so a
   * session a human has open stays both watchable and drivable.
   * @param sessionId - the session to look up.
   * @returns the live agent, or `undefined`.
   */
  liveAgent(sessionId) {
    const agents = this.ctx.get?.("agents") ?? this.ctx.agents;
    try {
      return agents?.get?.(sessionId);
    } catch {
      return undefined;
    }
  }

  /** Bind a live session to the driver that owns it. */
  register(sessionId, driver) {
    this.#bySession.set(sessionId, driver);
  }

  /**
   * Drop a binding only when it still points at this driver.
   *
   * Used when an adopted session is torn down by its real owner: the entry must
   * not outlive the agent it names, or the next attach would treat a dead agent
   * as a live driver.
   * @param sessionId - the session to unbind.
   * @param driver - the driver that must currently own the binding.
   */
  unregister(sessionId, driver) {
    if (this.#bySession.get(sessionId) === driver) this.#bySession.delete(sessionId);
  }

  /** Apply the first permission preset this host actually defines. */
  applyPreset(session) {
    const service = this.ctx.get("permissionPresets");
    if (service === undefined) return;
    for (const candidate of this.config.permissionPresets) {
      try {
        service.resolve(candidate);
        service.set(session, candidate);
        this.logger.info(`lobby-bot: 会话 ${session.id} 权限预设 = ${candidate}`);
        return;
      } catch {
        /* try the next candidate */
      }
    }
    this.logger.warn(`lobby-bot: 没有可用的权限预设（试过 ${this.config.permissionPresets.join(", ")}），沿用宿主默认`);
  }

  /** Pin a readable title so the GUI list says which bot and room a session is. */
  applyTitle(session, bot, room) {
    const service = this.ctx.get("sessionTitle");
    if (service === undefined) return;
    try {
      service.rename(session, sessionTitle({ nick: bot.nick, roomName: room.name }));
    } catch (error) {
      this.logger.warn(`lobby-bot: 设置标题失败：${String(error?.message ?? error)}`);
    }
  }

  /**
   * Start driving: read the roster, open the streams it asks for, and keep
   * checking for changes and for the lock. Idempotent — a host that wins the lock
   * later calls it.
   */
  async start() {
    if (this.#started) return;
    this.#started = true;
    await this.#applyRoster();
    void this.writeStatus();
    this.#heartbeat = setInterval(() => {
      for (const bot of this.roster.bots) void this.postStatus(bot, "online");
      void this.refreshLock();
    }, HEARTBEAT_MS);
    this.#heartbeat.unref?.();
    this.ctx.on("session/event", (session, event) => {
      this.#bySession.get(session.id)?.onSessionEvent(event);
    });
  }

  /**
   * Refresh this host's claim on the lobby's room streams.
   *
   * The lobby arbitrates: a live holder is never displaced, so this call is how a
   * second host discovers it must not drive. A driver that loses the lock closes
   * its streams instead of talking over the winner — two answers to one question
   * is worse than a moment of quiet.
   * A plain heartbeat also *asks*: the answer is whether this host drives, so a
   * host that lost the role finds out on its next beat instead of talking over the
   * winner. There is no "steal" option by design — a live holder always wins, and a
   * restarted host waits out the lobby's 90s stale window.
   * @returns whether this host drives after the call.
   */
  async refreshLock() {
    if (this.#store.login === null) return false;
    let result;
    try {
      result = await heartbeatLock({ baseUrl: this.baseUrl, token: this.token });
    } catch (error) {
      // A lobby that is restarting must not take every room down with it: keep
      // driving and try again on the next beat.
      this.logger.warn(`lobby-bot: 驱动锁心跳失败：${String(error?.message ?? error)}`);
      return this.#driving;
    }
    this.lockHolder = result.holder ?? null;
    if (result.driving) {
      if (!this.#driving) {
        this.#driving = true;
        this.logger.info("lobby-bot: 已接管驱动（服务端授予房间流驱动权）");
        await this.start();
        for (const bot of this.roster.bots) await this.postStatus(bot, "online", "驱动插件已接管");
      }
      return true;
    }
    if (this.#driving) {
      this.logger.warn(`lobby-bot: 驱动权已交给 ${describeHolder(result.holder)}，本实例停止开流`);
      await this.yieldDriving();
    }
    return false;
  }

  /** Stop driving (close streams, drop status) without forgetting the login. */
  async yieldDriving() {
    clearInterval(this.#heartbeat);
    clearInterval(this.#refreshTimer);
    this.#heartbeat = undefined;
    this.#refreshTimer = undefined;
    if (this.#driving) {
      for (const bot of this.roster.bots) await this.postStatus(bot, "offline", "驱动权已交给另一个宿主");
    }
    await Promise.all([...this.#drivers.values()].map((driver) => driver.stop()));
    this.#drivers.clear();
    this.#bySession.clear();
    this.#started = false;
    this.#driving = false;
  }

  /**
   * Ask the lobby whether this host may drive its rooms, and start driving if so.
   *
   * The command surface does **not** depend on this: every `/lobby` command must work on a
   * host that is not driving (another host may be), so commands are registered
   * separately. Only the room streams, heartbeat and status reporting need the lock.
   * @returns `true` when this host now drives.
   */
  async tryBecomeDriver() {
    if (this.#store.login === null) return false;
    if (this.#driving) return true;
    await this.refreshRoster();
    const driving = await this.refreshLock();
    if (!driving) {
      this.logger.warn(
        `lobby-bot: 已另有驱动在跑（${describeHolder(this.lockHolder)}）；本实例只提供 /lobby 命令面，${Math.round(LOCK_RETRY_MS / 1000)}s 后重试（对方静默超过 90s 才能接手）`,
      );
      return false;
    }
    void this.writeStatus();
    return true;
  }

  /**
   * Re-read the roster and align the running streams to it.
   *
   * Called on a timer and right after a command that changed the roster, which is what makes a
   * new bot come online in seconds instead of after a host restart. A failed read
   * keeps the current drivers running: a lobby that is restarting must not take
   * every room down with it.
   * @returns `{started, stopped, failed}` for logging and command output.
   */
  async refreshRoster() {
    if (this.#store.login === null) return { started: 0, stopped: 0, failed: true };
    let next;
    try {
      next = await fetchRoster({ baseUrl: this.baseUrl, token: this.token });
    } catch (error) {
      this.logger.warn(`lobby-bot: 读不到 roster，保持现状：${String(error?.message ?? error)}`);
      return { started: 0, stopped: 0, failed: true };
    }
    const before = this.roster;
    this.roster = next;
    this.lockHolder = next.driverLock ?? this.lockHolder;
    this.#syncModelOptions();
    if (!this.#driving) {
      // 不是驱动：名单只用来回答 /lobby list 这类问题，绝不去开流（那会变成两个驱动抢同一条会话）。
      return { started: 0, stopped: 0, failed: false };
    }
    const { start, stop } = await this.#applyRoster();
    // A bot that appeared is online now; one that vanished should not keep
    // pretending it is (its driver is gone with it).
    for (const bot of next.bots) {
      if (!before.bots.some((candidate) => candidate.id === bot.id)) {
        await this.postStatus(bot, "online", "驱动插件已接管");
      }
    }
    for (const bot of before.bots) {
      if (!next.bots.some((candidate) => candidate.id === bot.id)) {
        await this.postStatus(bot, "offline", "已从房间移除");
      }
    }
    if (start > 0 || stop > 0) {
      this.logger.info(`lobby-bot: roster 变更 → 新开 ${start} 个流、关掉 ${stop} 个流`);
      void this.writeStatus();
    }
    return { started: start, stopped: stop, failed: false };
  }

  /**
   * Apply the current roster to the running drivers.
   *
   * Retiring drivers are awaited, not merely asked to stop. `stop()` gives the
   * session back asynchronously, and a replacement driver for the same bot and
   * room that takes the session before its predecessor finished would be refused
   * by that predecessor's own still-open handle — the bot would then look online
   * and answer nothing until something else happened to attach it.
   * @returns `{start, stop}` counts.
   */
  async #applyRoster() {
    const active = [...this.#drivers.entries()].map(([key, driver]) => ({
      key,
      fingerprint: driver.fingerprint,
    }));
    const next = expandRoster(this.roster);
    const { start, stop } = diffRoster({ active, next });
    for (const key of stop) {
      const driver = this.#drivers.get(key);
      this.#drivers.delete(key);
      await driver?.stop();
      if (driver !== undefined) {
        for (const [sessionId, owner] of this.#bySession) {
          if (owner === driver) this.#bySession.delete(sessionId);
        }
      }
    }
    for (const entry of start) {
      const driver = new RoomDriver({ hub: this, bot: entry.bot, room: entry.room });
      this.#drivers.set(entry.key, driver);
      driver.fingerprint = entry.fingerprint ?? fingerprintOf(entry);
      driver.start();
      this.#prepareWorkspace(entry.bot);
    }
    // Roster refresh is also the retry clock for session ownership: a driver that
    // could not take its session (the Web GUI had it) tries again every round, so
    // the bot recovers by itself once the browser stops holding that session.
    for (const driver of this.#drivers.values()) driver.warm();
    return { start: start.length, stop: stop.length };
  }

  /**
   * Register a bot's workspace in the host as soon as this host drives that bot.
   *
   * Attaching registers the workspace too, but attaching happens on a turn — so a
   * bot created a moment ago owned no workspace anywhere until somebody spoke to
   * it. It was absent from the host's own workspace list, and because the mention
   * that would have spoken to it also arrived while its stream was still opening,
   * a freshly created bot looked online and answered nothing. Registering here
   * decouples "this bot is driven" from "this bot has spoken".
   *
   * Runs off the stream path and never throws: a workspace that cannot be prepared
   * is still attempted by {@link RoomDriver} at attach time, which is the attempt
   * that has to succeed for a turn to run at all.
   * @param bot - one roster bot.
   */
  #prepareWorkspace(bot) {
    if (typeof bot.workspace !== "string" || bot.workspace.length === 0) return;
    let registry;
    try {
      registry = this.service("workspaceRegistry");
    } catch (error) {
      this.logger.warn(`lobby-bot: ${bot.id} 无法预注册工作区：${String(error?.message ?? error)}`);
      return;
    }
    void (async () => {
      try {
        // `create` canonicalizes through realpath and rejects a missing directory,
        // while a bot's workspace is allowed to not exist until it is first used.
        await mkdir(bot.workspace, { recursive: true });
        const workspace = await registry.create(bot.workspace, bot.nick);
        this.logger.info(`lobby-bot: ${bot.id} 工作区已注册 ${workspace?.id ?? ""}（${bot.workspace}）`);
      } catch (error) {
        this.logger.warn(`lobby-bot: ${bot.id} 工作区预注册失败（${bot.workspace}）：${String(error?.message ?? error)}`);
      }
    })();
  }

  /** 这个会话是否已经属于别的房间驱动（一条会话只能服务一个房间）。 */
  driverForSession(sessionId) {
    return this.#bySession.get(sessionId);
  }

  /** Stop everything and say goodbye to the room. */
  async stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const bot of this.roster.bots) await this.postStatus(bot, "offline", "驱动插件已停止");
    await this.yieldDriving();
  }

  /**
  * One authenticated call to the lobby API, using the user's personal token.
   *
  * The personal token is the only long-lived identity credential and is reused
  * for room, bot, and driver requests.
   * @param method - HTTP method.
   * @param route - path.
   * @param body - JSON body for POSTs.
   * @returns `{ok, status, body, unauthorized}`; transport failures surface as `ok:false`.
   */
  async #api(method, route, body, token = this.token) {
    if (this.#store.login === null) {
      return { ok: false, status: 0, body: { error: "login_required", message: "还没有登录：先执行 /lobby <url> <token>" } };
    }
    try {
      const response = await fetch(new URL(route, this.baseUrl), {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let parsed;
      try {
        parsed = text.length === 0 ? {} : JSON.parse(text);
      } catch {
        parsed = { message: text.slice(0, 200) };
      }
      return { ok: response.ok, status: response.status, body: parsed, unauthorized: response.status === 401 };
    } catch (error) {
      return { ok: false, status: 0, body: { error: "unreachable", message: String(error?.message ?? error) } };
    }
  }

  /** 房间 id → 显示名。 */
  roomName(roomId) {
    return this.roster.rooms.find((room) => room.id === roomId)?.name ?? roomId;
  }

  /**
   * Register the `/lobby` command family.
   *
   * Commands are discovered by the GUI at runtime and rendered by its adapter, so
   * this is all it takes for `/lobby …` to appear in the composer — no client
   * plugin, no DSH changes.
   */
  registerCommands() {
    const commands = this.ctx.commands ?? this.ctx.get("commands");
    if (commands === undefined) {
      this.logger.warn("lobby-bot: 宿主没有命令面（dsh-commands 未挂载），/lobby 不可用；驱动本身照常");
      this.commandsRegistered = false;
      void this.writeStatus();
      return;
    }
    try {
      commands.register({
        name: "lobby",
        description: "把当前工作区接成聊天室里的我的机器人（join/list/leave/status）",
        input: { hint: "join <昵称> | list | leave <昵称|id> | status" },
        handler: ({ agent, rawInput }) => this.handleCommand({ agent, rawInput }),
      });
      this.commandsRegistered = true;
      this.logger.info("lobby-bot: 已注册 /lobby 命令");
    } catch (error) {
      // 重复挂载（同一宿主里加载了两份插件）不该让驱动停摆。
      this.commandsRegistered = false;
      this.logger.warn(`lobby-bot: 注册 /lobby 失败：${String(error?.message ?? error)}`);
    }
    void this.writeStatus();
  }

  /**
   * Write a minimal status line without the hub's own view.
   *
   * Used by `apply()` before anything that could fail, so "插件到底跑起来没有" is
   * answerable from the filesystem. A plugin that never applies and a plugin that
   * applies and dies look identical from the outside otherwise — which is exactly
   * how `/lobby` went missing with nothing in any log.
   * @param label - where in the startup the mark was written.
   * @param extra - additional fields to record.
   */
  async markStatus(label, extra = {}) {
    try {
      await this.#statusWriter?.({
        pid: process.pid,
        updatedAt: new Date().toISOString(),
        mark: label,
        commandsRegistered: this.commandsRegistered === true,
        loggedIn: this.#store.login !== null,
        url: this.#store.login?.url ?? null,
        storeFile: this.#store.file,
        ...extra,
      });
    } catch {
      // 写不出状态文件不该影响插件本身。
    }
  }

  /**
   * Write a small status file so "插件活着吗 / 它登录到哪儿了 / 它注册了什么" 能在终端里
   * 直接看到，而不必去翻 GUI 或宿主日志（宿主日志只记启动那一段）。
   *
   * It lives in the harness home rather than in a lobby checkout: after
   * `/lobby <url> <token>` there may be no checkout on this machine at all.
   * @returns a promise for the write (failures are logged, never thrown).
   */
  async writeStatus() {
    const file = path.join(dshHome(), "lobby-bot.status.json");
    const login = this.#store.login;
    const payload = {
      pid: process.pid,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      storeFile: this.#store.file,
      loggedIn: login !== null,
      url: login?.url ?? null,
      nick: this.ownerNick,
      driverId: login?.driverId ?? null,
      driving: this.#driving,
      lockHolder: this.lockHolder,
      commandsRegistered: this.commandsRegistered === true,
      bots: this.roster?.bots?.map((bot) => bot.id) ?? [],
      streams: [...this.#drivers.keys()],
    };
    try {
      if (this.#statusWriter !== undefined) {
        await this.#statusWriter({ ...payload, mark: "full" });
        return;
      }
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    } catch (error) {
      this.logger.warn(`lobby-bot: 写状态文件失败：${String(error?.message ?? error)}`);
    }
  }

  /**
   * Run one `/lobby …` invocation.
   * @param options - invocation.
   * @param options.agent - the agent that received the command.
   * @param options.rawInput - everything after `/lobby`.
   * @returns `{kind, text}` for the GUI to render.
   */
  async handleCommand({ agent, rawInput }) {
    const parsed = parseLobbyCommand(rawInput);
    if (parsed.error !== undefined) return { kind: "error", text: `${parsed.error}\n\n${LOBBY_HELP}` };
    switch (parsed.action) {
      case "help":
        return { kind: "success", text: LOBBY_HELP };
      case "status":
        return { kind: "success", text: this.statusText() };
      case "target":
        return this.login === null
          ? { kind: "error", text: "还没有登录：/lobby <url> <token>" }
          : { kind: "success", text: this.baseUrl };
      case "list":
        return { kind: "success", text: this.listText() };
      case "login":
        return this.loginFrom(parsed);
      case "logout":
        return this.logoutFrom();
      case "connect":
        return this.connectFrom({ agent, parsed });
      case "leave":
        return this.leaveBot(parsed);
      default:
        return { kind: "error", text: `未知子命令\n\n${LOBBY_HELP}` };
    }
  }

  /**
   * `/lobby <url> <token>` — 一步到位：登录（需要时）+ 把当前工作区接成我的机器人。
   *
   * 每天真正要敲的就是这一条：地址和 token 每次都带上（地址不能靠"默认值"猜——同事的机器、
   * 云上的房间服务、换过的端口都会猜错）。已经登录到同一个地址、同一个 token 时不重复登录，
   * 只是把当前工作区接上。
   * @param options - connect inputs.
   * @param options.agent - the receiving agent (its session's cwd is the workspace).
   * @param options.parsed - parsed command.
   * @returns the command result.
   */
  async connectFrom({ agent, parsed }) {
    const target = normalizeLobbyUrl(parsed.url);
    if (target === undefined) return { kind: "error", text: `不是合法的房间服务地址：${parsed.url}` };
    const same = this.login !== null && this.login.url === target && this.login.token === parsed.token;
    let headline;
    if (same) {
      headline = `✅ 已登录 ${this.baseUrl}（身份 ${this.ownerNick ?? "?"}）`;
    } else {
      const result = await this.loginTo({ url: parsed.url, token: parsed.token });
      if (!result.ok) return { kind: "error", text: `登录失败：${result.message}` };
      headline = `✅ 已登录 ${this.baseUrl}${result.lobby?.name === undefined ? "" : `（${result.lobby.name}）`}，身份 ${result.nick ?? "?"}`;
    }
    await this.refreshRoster();
    await this.refreshLock();
    void this.writeStatus();
    // 接 bot 用刚存下的凭据（`#api` 的默认 token），不再把命令里的 token 传一遍。
    const joined = await this.joinFrom({
      agent,
      parsed: {
        ...(parsed.nick === undefined ? {} : { nick: parsed.nick }),
        ...(parsed.id === undefined ? {} : { id: parsed.id }),
      },
    });
    if (joined.kind === "error") return { kind: "error", text: `${headline}\n登录成功，但没接上机器人：${joined.text}` };
    return { kind: "success", text: [headline, joined.text].join("\n") };
  }

  /**
   * `/lobby login <url> <token>` — 只登录、不接机器人的那条路（裸形式会顺带把当前工作区接上）。
   * @param parsed - parsed command.
   * @returns the command result.
   */
  async loginFrom(parsed) {
    const result = await this.loginTo({ url: parsed.url, token: parsed.token });
    if (!result.ok) return { kind: "error", text: `登录失败：${result.message}` };
    const roster = await this.refreshRoster();
    await this.refreshLock();
    void this.writeStatus();
    const lines = [
      `✅ 已登录 ${this.baseUrl}${result.lobby?.name === undefined ? "" : `（${result.lobby.name}）`}`,
      `身份：${result.nick ?? "?"}`,
      `房间：${this.roster.rooms.map((room) => room.name).join("、") || "（无）"}`,
      `可用机器人：${this.roster.bots.map((bot) => bot.nick).join("、") || `（还没有，用 /lobby <url> <token> 建一个）`}`,
    ];
    if (!this.driving) lines.push(`当前没有驱动权（${describeHolder(this.lockHolder)}），本实例只提供命令面。`);
    if (roster.failed) lines.push("警告：登录成功但读不到名册，稍后会自动重试。");
    return { kind: "success", text: lines.join("\n") };
  }

  /** `/lobby logout` — forget the personal token here and release driver state. */
  async logoutFrom() {
    if (this.login === null) return { kind: "error", text: "还没有登录。" };
    const url = this.baseUrl;
    await this.logout({ revoke: true });
    void this.writeStatus();
    return { kind: "success", text: `已退出 ${url}，本机凭据已删除${dshHome() === undefined ? "" : `（${this.#store.file}）`}。` };
  }

  /**
   * 把当前会话所在的工作区接成我的机器人。
   * @param options - join inputs.
   * @param options.agent - the receiving agent (its session's cwd is the workspace).
   * @param options.parsed - parsed command (`nick` / `id` / 可选的 `token` 覆盖).
   * @returns the command result.
   */
  async joinFrom({ agent, parsed }) {
    const cwd = agent?.session?.header?.cwd;
    if (typeof cwd !== "string" || cwd.length === 0) {
      return { kind: "error", text: "这个会话没有工作目录。先在某个工作区里开会话，再执行 /lobby <url> <token>。" };
    }
    const workspaceName = path.basename(path.resolve(cwd));
    const nick = parsed.nick ?? workspaceName;
    if (nick.length === 0 || nick.length > 32) {
      return { kind: "error", text: "工作区文件夹名必须是 1-32 个字符；也可以在命令末尾写上昵称。" };
    }
    const response = await this.#api("POST", "/api/bots", {
      nick,
      rooms: [],
      workspace: cwd,
      driver: "dsh",
      ...(parsed.id === undefined ? {} : { id: parsed.id }),
    }, parsed.token);
    if (!response.ok) {
      if (response.unauthorized) {
        return { kind: "error", text: "凭据已失效：请重新 /lobby <url> <token>。" };
      }
      const reason = response.body?.message ?? response.body?.error ?? `HTTP ${response.status}`;
      return { kind: "error", text: `没接上：${reason}` };
    }
    const bot = response.body.bot;
    await this.refreshRoster();
    const lines = [
      `${response.body.created === false ? "这个工作区已经登记了" : `✅ ${bot.nick} 已登录`}`,
      `归属用户：${bot.owner?.nick ?? "当前 token 用户"}`,
      `bot id：${bot.id}；当前未绑定房间`,
    ];
    if (parsed.id === undefined && bot.id.startsWith("bot-")) {
      lines.push(`（昵称是中文，机器 id 自动取成 ${bot.id}；想指定就写 id=<ascii>）`);
    }
    return { kind: "success", text: lines.join("\n") };
  }

  /**
   * 从房间摘掉一个我建的机器人。
   * @param parsed - parsed command (`target` = 昵称或 id).
   * @returns the command result.
   */
  async leaveBot(parsed) {
    const target = String(parsed.target ?? "");
    const bot = this.roster.bots.find((candidate) => candidate.id === target || candidate.nick === target);
    if (bot === undefined) return { kind: "error", text: `没有叫「${target}」的机器人。/lobby list 看清单。` };
    const response = await this.#api("POST", `/api/bots/${encodeURIComponent(bot.id)}/remove`);
    if (!response.ok) {
      const reason = response.body?.message ?? response.body?.error ?? `HTTP ${response.status}`;
      return { kind: "error", text: `没摘掉：${reason}` };
    }
    await this.refreshRoster();
    return { kind: "success", text: `🗑 ${bot.nick} 已从房间移除（工作目录与会话记录都保留，随时可以再 /lobby <url> <token> 接回来）` };
  }

  /** 所有可用机器人清单。 */
  listText() {
    if (this.login === null) return "还没有登录：先执行 /lobby <url> <token>";
    const mine = this.roster.bots;
    if (mine.length === 0) {
      return "还没有机器人：在某个工作区的会话里执行 /lobby <url> <token>";
    }
    return mine
      .map((bot) => {
        const sessions = bot.rooms
          .map((roomId) => {
            const sessionId = this.book.get(bot.id, roomId);
            return `#${this.roomName(roomId)}${sessionId === undefined ? "(待建)" : ` ${String(sessionId).slice(0, 8)}`}`;
          })
          .join("、");
        return `· ${bot.nick}（${bot.id}）${bot.enabled ? "" : "［已停用］"} → ${sessions}`;
      })
      .join("\n");
  }

  /** 驱动自身状态。 */
  statusText() {
    const login = this.login;
    if (login === null) {
      return [
        "登录：未登录",
        `凭据文件：${this.#store.file}`,
        "下一步：/lobby <url> <token>（token 是你的个人 token）",
      ].join("\n");
    }
    const bots = this.roster.bots.map((bot) => bot.nick).join("、") || "（无）";
    return [
      `登录：${login.url}（身份 ${login.nick ?? "?"}，驱动 id ${login.driverId ?? "?"}）`,
      `凭据文件：${this.#store.file}`,
      `房间：${this.roster.rooms.map((room) => room.name).join("、") || "（无）"}`,
      `驱动中的流：${this.#drivers.size} 个`,
      `可用机器人：${bots}`,
      `驱动锁：${this.#driving ? "本实例持有" : `不在本实例（${describeHolder(this.lockHolder)}）`}`,
    ].join("\n");
  }

  /** Tell the room this bot is alive (also a heartbeat). */
  async postStatus(bot, state, detail) {
    await this.#post(bot, "status", { state, ...(detail === undefined ? {} : { detail }) });
  }

  /** Show or clear the room's one transient indicator. */
  async postTyping(driver, typing) {
    await this.#post(driver.bot, "typing", { roomId: driver.room.id, typing });
  }

  /** Post one finished answer into the room. */
  async postMessage(driver, text) {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const chunks = trimmed.length > 4000 ? `${trimmed.slice(0, 3999)}…` : trimmed;
    await this.#post(driver.bot, "messages", { roomId: driver.room.id, text: chunks });
  }

  /** One authenticated call to the lobby's bot gateway. */
  async #post(bot, action, body) {
    try {
      const response = await fetch(new URL(`/api/bot/${bot.id}/${action}`, this.baseUrl), {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        this.logger.warn(`lobby-bot: ${bot.id} ${action} 返回 HTTP ${response.status}`);
      }
    } catch (error) {
      this.logger.warn(`lobby-bot: ${bot.id} ${action} 失败：${String(error?.message ?? error)}`);
    }
  }
}

/**
 * Plugin entry point.
 *
 * The host always starts, logged in or not: `/lobby` must be reachable so a human
 * can log in, and a room that cannot be driven is the lobby's problem — never the
 * GUI's. Without a personal token this plugin registers its commands and waits.
 * @param ctx - the host context.
 * @param config - the row config (`{url?, token?, permissionPresets?, digestIdleMs?}`).
 */
export async function apply(ctx, config) {
  const logger = loggerOf(ctx);
  const statusFile = path.join(dshHome(), "lobby-bot.status.json");
  const writeStatusFile = async (payload) => {
    await mkdir(path.dirname(statusFile), { recursive: true });
    await writeFile(statusFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  };
  // 第一件事就落盘：apply 有没有被调用，是这个问题唯一无法从别处推断的事实。
  await writeStatusFile({ pid: process.pid, updatedAt: new Date().toISOString(), mark: "apply-entered", inject })
    .catch(() => {});
  try {
    const settings = readConfig(config);
    const store = await LocalStore.load();
    const hub = new DriverHub({ ctx, config: settings, store, statusFile: writeStatusFile });
    ctx.effect(() => () => {
      void hub.stop();
    });
    // Commands work whether or not this host drives: 接一个 bot 是一条 lobby API
    // call plus a roster refresh, and another host may own the room streams.
    hub.registerCommands();

    // A row that carries `url` + `token` is a pre-filled login: it lets a fresh
    // machine come up working without anyone typing a secret into a chat box.
    if (hub.login === null && settings.url !== null && settings.token !== null) {
      const result = await hub.loginTo({ url: settings.url, token: settings.token });
      if (!result.ok) logger.warn(`lobby-bot: 行配置里的 url/token 登录失败：${result.message}`);
    }

    if (hub.login === null) {
      logger.warn(`lobby-bot: 尚未登录，不驱动任何房间；在任意会话里执行 /lobby <url> <token>（凭据文件 ${store.file}）`);
      void hub.writeStatus();
      // 房间服务可能只是比宿主晚起来（launchd 拉起、机器刚重启、lobby 正在重启），
      // 所以这里必须继续重试：否则一次"启动顺序不对"就要人重启 DSH 才能恢复。
      if (settings.url !== null && settings.token !== null) {
        const retry = setInterval(() => {
          if (hub.login !== null) {
            clearInterval(retry);
            return;
          }
          void hub.recoverLogin({ url: settings.url, token: settings.token });
        }, LOGIN_RETRY_MS);
        retry.unref?.();
      }
      return;
    }

    // A remembered personal token is verified before it is trusted: a lobby that
    // rotated its token or revoked this driver must leave a message a human can
    // act on, not a room that silently answers nothing.
    const verified = await hub.verifyLogin();
    if (!verified.ok) {
      if (settings.url !== null && settings.token !== null) {
        logger.warn(`lobby-bot: 保存的个人 token 不可用（${verified.message}），改用 profile row 中的 token 重新登录`);
        await hub.logout({ revoke: false });
        const result = await hub.loginTo({ url: settings.url, token: settings.token });
        if (!result.ok) {
          logger.warn(`lobby-bot: profile row 登录失败：${result.message}`);
          void hub.writeStatus();
          return;
        }
      } else {
        logger.warn(`lobby-bot: 个人 token 不可用（${verified.message}）；请重新 /lobby <url> <token>`);
        void hub.writeStatus();
        return;
      }
    }
    logger.info(`lobby-bot: 已登录 ${hub.baseUrl}${verified.lobby?.name === undefined ? "" : `（${verified.lobby.name}）`}`);

    // One machine may run several DSH hosts; the lobby decides which one drives.
    // A host that just restarted cannot inherit the role, so keep asking.
    const driving = await hub.tryBecomeDriver();
    if (!driving) {
      const retry = setInterval(() => void hub.tryBecomeDriver(), LOCK_RETRY_MS);
      retry.unref?.();
    }

    // The roster changes from outside this process (someone runs `/lobby <url> <token>` on
    // another host), so it is re-read rather than cached for the host's lifetime.
    const refresh = setInterval(() => void hub.refreshRoster(), ROSTER_REFRESH_MS);
    refresh.unref?.();
  } catch (error) {
    // This code runs inside the user's DSH host process: a throw here would fail
    // the plugin tree and take the GUI down with it. A room that cannot be driven
    // is a broken room; a host that will not boot is a broken machine.
    logger.error(`lobby-bot: 驱动启动失败，插件待机（不影响宿主）：${String(error?.stack ?? error)}`);
    await writeStatusFile({
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      mark: "apply-threw",
      message: String(error?.message ?? error),
      stack: String(error?.stack ?? "").split("\n").slice(0, 6).join("\n"),
    }).catch(() => {});
  }
}

/**
 * Unit tests for the DSH-side driver plugin (`dsh-lobby-bot/`).
 *
 * The parts tested here are the ones that must be right without a DSH host
 * running: the trigger/queue policy (a wrong answer is a bot that replies twice or
 * loses a question), the SSE framing (a missed frame is a bot that goes silent),
 * the session decision (adopting the wrong id is a bot that forgets), the driver
 * lock (two hosts driving one room is two answers per question), and the installer
 * (it edits a file the user owns, so it must be exactly reversible).
 * @module tests/plugin.test
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { describeHolder, heartbeatLock, STALE_MS } from "../lib/lock.mjs";
import { LocalStore, normalizeLobbyUrl } from "../lib/local-store.mjs";
import { fetchRoster } from "../lib/roster.mjs";
import { buildDigest, formatPrompt, sessionTitle } from "../lib/prompt.mjs";
import { LOBBY_HELP, parseLobbyCommand } from "../lib/command-input.mjs";
import { SseParser } from "../lib/room-stream.mjs";
import { diffRoster, expandRoster, pairKey } from "../lib/roster-diff.mjs";
import { adoptableLiveAgent, decideSession, SessionBook } from "../lib/session-book.mjs";
import { botChainLength, maxBotChainOf, shouldTrigger, TurnQueue } from "../lib/turn-policy.mjs";
import { inspect, install, revert } from "../bin/install.mjs";

/** A bot configuration as the roster produces it. */
const bot = { id: "xiaoyun", nick: "小运", mode: "mention", minIntervalMs: 2000, persona: "", contextDigest: {} };

/** A human message in a room. */
const human = (text) => ({ kind: "human", author: { id: "u1", nick: "阿哲" }, text });

test("触发策略：mention 只认被点名，always 认所有人类发言并受最小间隔限制", () => {
  assert.equal(shouldTrigger({ bot, event: "mention", message: human("@小运 在吗"), lastTurnAt: undefined, now: 0 }), true);
  assert.equal(shouldTrigger({ bot, event: "message", message: human("随便聊聊"), lastTurnAt: undefined, now: 0 }), false);

  const chatty = { ...bot, mode: "always" };
  assert.equal(shouldTrigger({ bot: chatty, event: "message", message: human("在吗"), lastTurnAt: 0, now: 1000 }), false);
  assert.equal(shouldTrigger({ bot: chatty, event: "message", message: human("在吗"), lastTurnAt: 0, now: 2000 }), true);
  // 被点名永远优先，不受间隔影响。
  assert.equal(shouldTrigger({ bot: chatty, event: "mention", message: human("@小运 急"), lastTurnAt: 0, now: 1 }), true);

  // 系统行与自己说的话都不触发。
  assert.equal(shouldTrigger({ bot, event: "mention", message: { kind: "system", text: "小运 上线" }, now: 1e9 }), false);
  assert.equal(
    shouldTrigger({ bot, event: "mention", message: { kind: "bot", author: { id: "bot_xiaoyun" }, text: "@小运 我自己" }, now: 1e9 }),
    false,
  );
});

test("触发策略：别的 bot 的发言受会话预算约束，人类点名不受冷却约束", () => {
  const peer = { kind: "bot", author: { id: "bot_xiaozhu", nick: "小助" }, text: "@小运 你看" };
  // 链长在预算内可以接话，超出就断。
  assert.equal(shouldTrigger({ bot, event: "mention", message: peer, botChain: 1, now: 0 }), true);
  assert.equal(shouldTrigger({ bot, event: "mention", message: peer, botChain: 3, now: 0 }), true);
  assert.equal(shouldTrigger({ bot, event: "mention", message: peer, botChain: 4, now: 0 }), false);
  // 严格模式：bot 之间永不互相触发。
  assert.equal(shouldTrigger({ bot: { ...bot, maxBotChain: 0 }, event: "mention", message: peer, botChain: 1, now: 0 }), false);
  // 缺字段落回默认 3，而不是变成不设防。
  assert.equal(maxBotChainOf(bot), 3);
  assert.equal(maxBotChainOf({ ...bot, maxBotChain: 0 }), 0);
  assert.equal(maxBotChainOf({ ...bot, maxBotChain: -1 }), 3);

  // 冷却只掐 bot 之间的接话：人的问题在冷却期内也必须照答。
  assert.equal(shouldTrigger({ bot, event: "mention", message: human("@小运 急"), lastTurnAt: 9_999, now: 10_000 }), true);
  assert.equal(shouldTrigger({ bot, event: "mention", message: peer, botChain: 1, lastTurnAt: 9_999, now: 10_000 }), false);
  assert.equal(shouldTrigger({ bot, event: "mention", message: peer, botChain: 1, lastTurnAt: 7_000, now: 10_000 }), true);

  // always 模式只认人类发言——这条分支以前根本没有 bot 检查。
  const chatty = { ...bot, mode: "always", minIntervalMs: 0 };
  assert.equal(shouldTrigger({ bot: chatty, event: "message", message: peer, now: 1e9 }), false);
  assert.equal(shouldTrigger({ bot: chatty, event: "mention", message: peer, now: 1e9 }), false);
});

test("botChainLength 数的是结尾的 bot 连发，系统行透明", () => {
  const botLine = (id) => ({ kind: "bot", author: { id }, text: "机" });
  const systemLine = { kind: "system", author: { id: "system" }, text: "上线" };
  assert.equal(botChainLength([human("人")]), 0);
  assert.equal(botChainLength([]), 0);
  assert.equal(botChainLength([human("人"), botLine("bot_a"), botLine("bot_b")]), 2);
  // 上下线/合并提示不是人类接话，不能把链冲断。
  assert.equal(botChainLength([botLine("bot_a"), systemLine, botLine("bot_b")]), 2);
  assert.equal(botChainLength([botLine("bot_a"), human("人"), botLine("bot_b")]), 1);
});

test("回合队列：一次只跑一个，溢出合并而不是丢弃", () => {
  const queue = new TurnQueue({ limit: 2 });
  assert.equal(queue.running, false);
  assert.equal(queue.push(human("第一条")), "run");
  assert.equal(queue.running, true);
  assert.equal(queue.push(human("第二条")), "queued");
  assert.equal(queue.push(human("第三条")), "queued");
  assert.equal(queue.push(human("第四条")), "merged");
  assert.equal(queue.merged, 1);
  assert.equal(queue.size, 2);

  const first = queue.next();
  assert.equal(first.length, 1);
  const second = queue.next();
  assert.equal(second.length, 2, "被合并的那条要跟着一起回答");
  assert.equal(queue.next(), undefined);
  assert.equal(queue.running, false);

  queue.push(human("a"));
  queue.push(human("b"));
  queue.clear();
  assert.equal(queue.size, 0);
});

test("回合队列：房间喊停时在飞的回合仍在跑，但排队的一起丢", () => {
  const queue = new TurnQueue({ limit: 3 });
  assert.equal(queue.push(human("第一条")), "run");
  assert.equal(queue.push(human("第二条")), "queued");
  assert.equal(queue.push(human("第三条")), "queued");
  assert.equal(queue.size, 2);

  // /stop 到达时清队列，但 running 必须保持 true：在飞的回合还没结束，
  // 现在把它标成空闲会让 #runTurn 的 finally 和下一个触发者同时开跑。
  queue.clear();
  assert.equal(queue.size, 0);
  assert.equal(queue.merged, 0);
  assert.equal(queue.running, true, "在飞回合结束前不能回到空闲");

  // 在飞回合收尾：拿不到下一批，此时才归零，之后又能正常开新一轮。
  assert.equal(queue.next(), undefined);
  assert.equal(queue.running, false);
  assert.equal(queue.push(human("新的一条")), "run");
  assert.equal(queue.running, true);
});

test("prompt：首行自带标题所需信息，摘要只含别人的话", () => {
  const messages = [
    human("@小运 你好"),
    { kind: "bot", author: { id: "bot_xiaoyun", nick: "小运" }, text: "我上一句" },
    human("@小运 再问一次"),
  ];
  const digest = buildDigest({ messages, botId: "xiaoyun", maxMessages: 12, maxBytes: 4096 });
  assert.equal(digest.includes("我上一句"), false, "不要在摘要里自我引用");
  assert.equal(digest.includes("再问一次"), true);

  // 触发消息由 formatPrompt 逐条渲染，摘要必须把它排除，否则同一句话出现两次。
  const bounded = buildDigest({ messages, botId: "xiaoyun", exclude: [messages[2]], maxMessages: 12, maxBytes: 4096 });
  assert.equal(bounded.includes("再问一次"), false, "触发消息不能留在摘要里");

  const prompt = formatPrompt({
    bot: { ...bot, persona: "你是运维助手。" },
    roomName: "运维",
    triggers: [messages[2]],
    digest,
    includeDigest: true,
    now: new Date("2026-09-15T09:20:00Z"),
  });
  const header = prompt.split("\n")[0];
  assert.match(header, /^【小运】 运维 \d{2}-\d{2} \d{2}:\d{2} ·$/);
  assert.equal(prompt.includes("你是运维助手。"), true);
  assert.equal(sessionTitle({ nick: "小运", roomName: "运维" }), "【小运】 运维");
});

test("prompt：lobby 的能力说明书原样追加，只替换房间占位符", () => {
  const prompt = formatPrompt({
    bot: { ...bot, manual: "【Lobby 接口】\nPOST /api/rooms/{{roomId}}/cron\nEND" },
    roomId: "ops",
    roomName: "运维",
    triggers: [human("@小运 建个任务")],
    includeDigest: false,
    now: new Date("2026-09-15T09:20:00Z"),
  });
  assert.match(prompt, /POST \/api\/rooms\/ops\/cron/);
  assert.equal(prompt.includes("{{roomId}}"), false, "占位符必须被替换");
  assert.equal(prompt.includes("END"), true, "说明书内容原样保留");

  const none = formatPrompt({
    bot,
    roomId: "ops",
    roomName: "运维",
    triggers: [human("@小运 你好")],
    includeDigest: false,
  });
  assert.equal(none.includes("Lobby 接口"), false, "没有说明书就不追加");
});

test("SSE 解析：跨 chunk、多行 data、注释与 id 都要处理对", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push(": keep-alive\n\nevent: pi"), [], "半帧不产出");
  const frames = parser.push('ng\ndata: {"t":1}\n\nid: 12\nevent: mention\ndata: {"kind":"human"}\n\n');
  assert.equal(frames.length, 2);
  assert.equal(frames[0].event, "ping");
  assert.deepEqual(frames[0].data, { t: 1 });
  assert.equal(frames[1].event, "mention");
  assert.equal(frames[1].id, "12");
  // 多行 data 按 SSE 规则用换行拼接后再解析。
  const multiline = parser.push('event: message\ndata: {"kind":\ndata: "human"}\n\n');
  assert.deepEqual(multiline[0].data, { kind: "human" });
});

test("会话决策：记得住且宿主里还在就采纳，否则新建", () => {
  assert.deepEqual(decideSession({ remembered: "abc", resumable: true }), { action: "resume", sessionId: "abc" });
  assert.deepEqual(decideSession({ remembered: "abc", resumable: false }), { action: "create", sessionId: undefined, forgot: true });
  assert.deepEqual(decideSession({}), { action: "create", sessionId: undefined, forgot: false });
});

test("会话决策：GUI 已把会话 resume 成 live agent 时，驱动采纳它而不是硬抢写锁", () => {
  const agent = { id: "lobby-5a" };
  const self = {};
  // GUI（或别的视图）持有同一 session 的 live agent，且没有别的房间驱动占着 → 采纳。
  assert.equal(adoptableLiveAgent({ remembered: "lobby-5a", live: agent, owner: undefined, self }), agent);
  // 没记住会话、或宿主里没有 live agent → 不采纳，走正常的 resume/create。
  assert.equal(adoptableLiveAgent({ remembered: undefined, live: agent, owner: undefined, self }), undefined);
  assert.equal(adoptableLiveAgent({ remembered: "lobby-5a", live: undefined, owner: undefined, self }), undefined);
  // 已被另一个房间驱动绑定 → 不能采纳（一条会话只服务一个房间）。
  assert.equal(adoptableLiveAgent({ remembered: "lobby-5a", live: agent, owner: {}, self }), undefined);
  // 绑定给本驱动自己 → 仍可采纳（幂等重入）。
  assert.equal(adoptableLiveAgent({ remembered: "lobby-5a", live: agent, owner: self, self }), agent);
});

test("会话账本：读写房间→会话映射，凭据与账本同存一个 0600 文件", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "lobby-store-"));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const store = await LocalStore.load();
    assert.equal(store.login, null, "没登录时 login 应为 null，而不是一个空壳");

    await store.setLogin({ url: "http://192.168.1.9:8770", nick: "哲", token: "cred-1", driverId: "dr_x", expiresAt: "2026-12-14T00:00:00.000Z" });
    assert.equal(store.login.url, "http://192.168.1.9:8770");
    assert.equal((await stat(store.file)).mode & 0o777, 0o600, "凭据文件必须是 0600");

    const book = await SessionBook.load({ store });
    assert.equal(book.get("xiaoyun", "ops"), undefined);
    await book.record({ botId: "xiaoyun", roomId: "ops", sessionId: "s-1", lastTurnAt: 123 });

    // 重新加载：登录还在，账本也在。
    const reloadedStore = await LocalStore.load();
    assert.equal(reloadedStore.login.token, "cred-1");
    const reloaded = await SessionBook.load({ store: reloadedStore });
    assert.equal(reloaded.get("xiaoyun", "ops"), "s-1");
    assert.equal(reloaded.lastTurnAt("xiaoyun", "ops"), 123);

    // 退出只清凭据，账本是历史，不该跟着消失。
    await reloadedStore.clearLogin();
    assert.equal((await LocalStore.load()).login, null);
    assert.equal((await SessionBook.load({ store: await LocalStore.load() })).get("xiaoyun", "ops"), "s-1");
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("地址归一化：裸 host 补 http://，尾部斜杠去掉，非法值拒绝", () => {
  assert.equal(normalizeLobbyUrl("192.168.1.9:8770"), "http://192.168.1.9:8770");
  assert.equal(normalizeLobbyUrl("http://127.0.0.1:8770/"), "http://127.0.0.1:8770");
  assert.equal(normalizeLobbyUrl("https://room.example.com/lobby/"), "https://room.example.com/lobby");
  assert.equal(normalizeLobbyUrl(""), undefined);
  assert.equal(normalizeLobbyUrl("   "), undefined);
  assert.equal(normalizeLobbyUrl("http://"), undefined);
});

test("驱动锁：活着的人永远赢，静默超时后由服务端放行", async () => {
  const calls = [];
  // 假服务端：复刻 lobby 的仲裁规则，验证客户端把结论翻译对。
  const fakeLobby = async (url, options) => {
    calls.push({ url: String(url), token: options.headers.Authorization });
    const body = JSON.parse(options.body);
    const held = holder;
    if (held !== undefined && held.driverId !== body.driverId && Date.now() - held.heartbeatAt < STALE_MS) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, driver: false, holder: held }) };
    }
    holder = { driverId: body.driverId, nick: "哲", host: "http://x", heartbeatAt: Date.now() };
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, driver: true, holder }) };
  };
  let holder;

  const first = await heartbeatLock({ baseUrl: "http://127.0.0.1:8770", token: "c1", fetchImpl: async (url, o) => { o.body = JSON.stringify({ driverId: "dr_a" }); return fakeLobby(url, o); } });
  assert.equal(first.driving, true);

  const second = await heartbeatLock({ baseUrl: "http://127.0.0.1:8770", token: "c2", fetchImpl: async (url, o) => { o.body = JSON.stringify({ driverId: "dr_b" }); return fakeLobby(url, o); } });
  assert.equal(second.driving, false, "另一个驱动不能抢走活着的持有者");
  assert.equal(second.holder.driverId, "dr_a");

  // 持有者静默超过陈旧窗口 → 后来者接手。
  holder = { ...holder, heartbeatAt: Date.now() - STALE_MS - 1 };
  const third = await heartbeatLock({ baseUrl: "http://127.0.0.1:8770", token: "c2", fetchImpl: async (url, o) => { o.body = JSON.stringify({ driverId: "dr_b" }); return fakeLobby(url, o); } });
  assert.equal(third.driving, true, "陈旧锁必须能被接手，否则进程被 kill 后房间永远没人驱动");

  assert.match(calls[0].url, /\/api\/driver\/lock\/heartbeat$/);
  assert.equal(calls[0].token, "Bearer c1");
  assert.match(describeHolder({ driverId: "dr_a", nick: "哲", heartbeatAt: Date.now() - 5000 }), /哲/);
  assert.equal(describeHolder(null), "无人持有");
});

test("名册：返回全部 DSH bot，形状带齐一份配置该有的字段", async () => {
  const seen = [];
  const roster = await fetchRoster({
    baseUrl: "http://127.0.0.1:8770",
    token: "cred",
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), auth: options.headers.Authorization });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          rooms: [{ id: "general", name: "大厅" }],
          bots: [
            { id: "xiaoyun", nick: "小运", driver: "dsh", enabled: true, rooms: ["general"], mode: "mention", botToken: "bt", workspace: "/w", manual: "POST /api/rooms/{{roomId}}/cron" },
            // 本地驱动的 bot 不归这个驱动管，必须被滤掉。
            { id: "localbot", nick: "本地", driver: "local", enabled: true, rooms: ["general"], botToken: "bt2" },
          ],
        }),
      };
    },
  });
  assert.match(seen[0].url, /\/api\/driver\/roster$/);
  assert.equal(seen[0].auth, "Bearer cred");
  assert.deepEqual(roster.bots.map((b) => b.id), ["xiaoyun"]);
  assert.equal(roster.bots[0].queueLimit, 3, "缺省值必须由服务端补齐，驱动侧不该猜");
  assert.equal(roster.bots[0].maxBotChain, 3);
  assert.equal(roster.bots[0].minIntervalMs, 2000);
  assert.equal(roster.bots[0].manual, "POST /api/rooms/{{roomId}}/cron", "lobby 下发的能力说明书要原样带上");
  assert.equal(roster.bots[0].exchangeSecret, undefined, "兑换密钥已内嵌进说明书，不再单独下发");
});

test("名册：凭据失效时报出的是「重新登录」，不是一句 HTTP 401", async () => {
  await assert.rejects(
    fetchRoster({ baseUrl: "http://127.0.0.1:8770", token: "gone", fetchImpl: async () => ({ ok: false, status: 401, text: async () => "{}" }) }),
    /重新 \/lobby <url> <token>/,
  );
});

test("插件安装器：装完能查得到，还原后 profile 与现场都干净", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "lobby-dshhome-"));
  const profileDir = path.join(home, "profiles", "web");
  await mkdir(profileDir, { recursive: true });
  const patchFile = path.join(profileDir, "cordis.patch.yml");
  const original = "# 用户自己的 patch 层\n- id: remote-web-ui\n  config:\n    autoTunnel: false\n";
  await writeFile(patchFile, original, "utf8");
  const TEST_URL = "http://127.0.0.1:8770";

  try {
    const before = await inspect({ dshHome: home, url: TEST_URL });
    assert.equal(before.installed, false);
    assert.equal(before.rowPresent, false);

    const applied = await install({ dshHome: home, url: TEST_URL });
    assert.equal(applied.installed ?? true, true);
    const after = await inspect({ dshHome: home, url: TEST_URL });
    assert.equal(after.installed, true);
    assert.equal(after.rowPresent, true);
    const patched = await readFile(patchFile, "utf8");
    assert.equal(patched.startsWith(original.trimEnd()), true, "用户原有内容必须原样保留在前面");
    assert.match(patched, /name: 'dsh-lobby-bot'/);
    assert.match(patched, /url: "http:\/\/127\.0\.0\.1:8770"/, "row 里要写登录地址，插件靠它自动登录");
    assert.doesNotMatch(patched, /token: /, "安装器不能把静态管理令牌写入插件配置");

    // 重复安装不该插入第二条 row。
    await install({ dshHome: home, url: TEST_URL });
    assert.equal((await readFile(patchFile, "utf8")).match(/name: 'dsh-lobby-bot'/g).length, 1);

    await revert({ dshHome: home, url: TEST_URL });
    const restored = await readFile(patchFile, "utf8");
    assert.equal(restored.trim(), original.trim(), "还原来必须只剩用户原来那一层");
    assert.equal((await inspect({ dshHome: home, url: TEST_URL })).installed, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
/** DSH 给全新 profile 写的 `cordis.patch.yml` 就是这个形状（`@deepseek-ai/dsh-app-boot` 的模板）。 */
const DSH_PATCH_TEMPLATE = [
  "# Your patch layer for this dsh profile, applied after every bundle layer:",
  "# a top-level YAML array of loader patch entries (id-targeted config",
  "# overrides, disables, and insert lists; `!!js` expressions allowed).",
  "[]",
  "",
].join("\n");

/** 一段 patch 文本里的"有效行"：去掉注释与空行。 */
function significantLines(text) {
  return text.split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
}

test("插件安装器：空层（DSH 模板的 `[]`）要被替换，不能追加成非法 YAML", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "lobby-dshhome-"));
  const profileDir = path.join(home, "profiles", "web");
  await mkdir(path.join(profileDir, "node_modules"), { recursive: true });
  await writeFile(path.join(profileDir, "package.json"), JSON.stringify({ name: "dsh-profile-web" }), "utf8");
  const patchFile = path.join(profileDir, "cordis.patch.yml");
  await writeFile(patchFile, DSH_PATCH_TEMPLATE, "utf8");
  const TEST_URL = "http://127.0.0.1:8770";

  try {
    const applied = await install({ dshHome: home, url: TEST_URL });
    assert.equal(applied.resolvable, true, "装完宿主必须解析得到插件");
    const patched = await readFile(patchFile, "utf8");
    // `[]` 是 flow 序列，后面再跟 `- insert:` 会让整份文档解析失败：DSH 报
    // `failed to parse …` 然后 Harness 起不来。所以两者绝不能并存。
    assert.equal(
      patched.split("\n").some((line) => line.trim() === "[]"),
      false,
      "空层的 [] 必须被换掉，不能和条目同时留在文件里",
    );
    assert.match(patched, /# a top-level YAML array of loader patch entries/, "用户那一层的注释头要保留");
    const significant = significantLines(patched);
    assert.equal(significant[0], "- insert:", "有效内容必须是 block 序列");
    assert.equal(significant.filter((line) => line.startsWith("- ")).length, 1, "顶层只能有一个条目");

    // 再装一次：还是只有一份
    await install({ dshHome: home, url: TEST_URL });
    assert.equal((await readFile(patchFile, "utf8")).match(/id: lobby-bot/g).length, 1);

    // 还原：回到 DSH 模板的形状（注释头 + `[]`），不是空文件
    await revert({ dshHome: home, url: TEST_URL });
    assert.equal((await readFile(patchFile, "utf8")).trim(), DSH_PATCH_TEMPLATE.trim());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("插件安装器：手写过的 row（没有 marker 注释）再装不会留下两份 id: lobby-bot", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "lobby-dshhome-"));
  const profileDir = path.join(home, "profiles", "web");
  await mkdir(profileDir, { recursive: true });
  const patchFile = path.join(profileDir, "cordis.patch.yml");
  // 文档里教人"手改也行"，那就是一段没有 marker 的 row。
  const handwritten = [
    "# 用户自己的 patch 层",
    "- insert:",
    "    - id: lobby-bot",
    "      name: dsh-lobby-bot",
    "      config:",
    "        url: http://127.0.0.1:8770",
    "",
  ].join("\n");
  await writeFile(patchFile, handwritten, "utf8");
  const TEST_URL = "http://127.0.0.1:8770";

  try {
    await install({ dshHome: home, url: TEST_URL });
    const patched = await readFile(patchFile, "utf8");
    // 重复的 id 会让 DSH 直接拒绝启动（duplicate loader entry id: lobby-bot）。
    assert.equal((patched.match(/id: lobby-bot/g) ?? []).length, 1);
    assert.equal((patched.match(/name: ['"]?dsh-lobby-bot['"]?/g) ?? []).length, 1);

    await revert({ dshHome: home, url: TEST_URL });
    const restored = await readFile(patchFile, "utf8");
    assert.equal(restored.includes("dsh-lobby-bot"), false, "还原后不该再有任何插件行");
    assert.equal(restored.trim(), "# 用户自己的 patch 层\n[]");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("插件安装器：地址与 token 写成带引号的标量（token 里的 # / : 不再弄坏 YAML）", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "lobby-dshhome-"));
  const profileDir = path.join(home, "profiles", "web");
  await mkdir(profileDir, { recursive: true });
  const patchFile = path.join(profileDir, "cordis.patch.yml");
  await writeFile(patchFile, DSH_PATCH_TEMPLATE, "utf8");

  try {
    const applied = await install({
      dshHome: home,
      url: "http://192.168.1.9:8770",
      token: "tk_a.b#c:d",
      owner: "小 张",
    });
    const patched = await readFile(patchFile, "utf8");
    assert.match(patched, /url: "http:\/\/192\.168\.1\.9:8770"/);
    assert.match(patched, /token: "tk_a\.b#c:d"/);
    assert.match(patched, /owner: "小 张"/);
    // 读回配置也要对得上（旧文件里是裸标量，也要能读回来）
    assert.equal(applied.url, "http://192.168.1.9:8770");
    assert.equal(applied.owner, "小 张");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("命令解析：裸形式 `/lobby <url> <token>` 就是登录 + 接机器人", () => {
  assert.deepEqual(parseLobbyCommand("http://192.168.1.9:8770 tk_a.b"), {
    action: "connect",
    url: "http://192.168.1.9:8770",
    token: "tk_a.b",
  });
  // 地址可以省 scheme，昵称/id 写在后面
  assert.deepEqual(parseLobbyCommand("  192.168.1.9:8770 tk_test 小张 id=xiaozhang"), {
    action: "connect",
    url: "192.168.1.9:8770",
    token: "tk_test",
    nick: "小张",
    id: "xiaozhang",
  });
  // key=value 写法也认；带引号的昵称里可以有空格
  assert.deepEqual(parseLobbyCommand("url=10.0.0.2:8770 token=tk_test \"小 张\""), {
    action: "connect",
    url: "10.0.0.2:8770",
    token: "tk_test",
    nick: "小 张",
  });
  // 地址是必须的：不能靠"默认地址"猜（同事的机器、云上的服务、换过的端口都会猜错）
  assert.match(parseLobbyCommand("tk_test").error, /用法：\/lobby <url> <token>/);
  assert.match(parseLobbyCommand("http://127.0.0.1:8770").error, /缺少凭据/);
  // login 仍然只登录；join 已经并进裸形式
  assert.deepEqual(parseLobbyCommand("login http://x:1 tk_a"), { action: "login", url: "http://x:1", token: "tk_a" });
  assert.match(parseLobbyCommand("join tk_a").error, /直接写 \/lobby <url> <token>/);
  // 打错一个词时说清用法，而不是静默
  assert.match(parseLobbyCommand("nonsense").error, /用法：\/lobby <url> <token>/);
  assert.match(parseLobbyCommand("http://x:1 tk_a room=general").error, /不绑定房间/);
  // 空输入 = 帮助
  assert.equal(parseLobbyCommand("").action, "help");
  assert.match(LOBBY_HELP, /\/lobby <url> <token>/);
});


test("命令解析：leave / list / status / logout 这些还有效", () => {
  assert.deepEqual(parseLobbyCommand("leave bot-1"), { action: "leave", target: "bot-1" });
  assert.match(parseLobbyCommand("leave").error, /用法/);
  assert.equal(parseLobbyCommand("list").action, "list");
  assert.equal(parseLobbyCommand("status").action, "status");
  assert.equal(parseLobbyCommand("logout").action, "logout");
  assert.equal(parseLobbyCommand("target").action, "target");
});

test("roster 差分：新增开流、消失关流、行为参数变了重开、没变就不动", () => {
  const bot = (id, over = {}) => ({ id, nick: id, driver: "dsh", mode: "mention", minIntervalMs: 2000, queueLimit: 3, promptTimeoutMs: 1000, workspace: `/w/${id}`, persona: "", contextDigest: {}, rooms: ["general"], ...over });
  const room = { id: "general", name: "大厅" };
  const entry = (b, r = room) => ({ key: pairKey(b.id, r.id), bot: b, room: r });

  const first = expandRoster({ rooms: [room], bots: [bot("a"), bot("b")] });
  assert.deepEqual(first.map((item) => item.key), ["a/general", "b/general"]);

  // 全新：两个都要开
  const initial = diffRoster({ active: [], next: first });
  assert.deepEqual(initial.start.map((item) => item.key), ["a/general", "b/general"]);
  assert.deepEqual(initial.stop, []);

  const active = initial.start.map((item) => ({ key: item.key, fingerprint: item.fingerprint }));

  // 没变：什么都不做（保住 Last-Event-ID，不白重连）
  const stable = diffRoster({ active, next: expandRoster({ rooms: [room], bots: [bot("a"), bot("b")] }) });
  assert.deepEqual(stable, { start: [], stop: [] });

  // b 被摘掉、c 新增、a 的工作区变了 → 关 b、关 a 再开 a、开 c
  const changed = diffRoster({
    active,
    next: expandRoster({ rooms: [room], bots: [bot("a", { workspace: "/w/a2" }), bot("c")] }),
  });
  assert.deepEqual(changed.stop.sort(), ["a/general", "b/general"]);
  assert.deepEqual(changed.start.map((item) => item.key).sort(), ["a/general", "c/general"]);

  // 改模式也算行为变化
  const modeChanged = diffRoster({ active, next: expandRoster({ rooms: [room], bots: [bot("a", { mode: "always" }), bot("b")] }) });
  assert.deepEqual(modeChanged.stop, ["a/general"]);

  // lobby 下发的说明书变了也要重开：加能力/换时区必须在下一轮就生效，不等插件发版
  const manualChanged = diffRoster({ active, next: expandRoster({ rooms: [room], bots: [bot("a", { manual: "POST /api/rooms/{{roomId}}/cron" }), bot("b")] }) });
  assert.deepEqual(manualChanged.stop, ["a/general"]);

  // 房间名变了不算行为变化？算——标题要跟着改，但只影响标题，重开代价小，这里允许重开。
  const roomRenamed = diffRoster({ active, next: expandRoster({ rooms: [{ id: "general", name: "大厅2" }], bots: [bot("a"), bot("b")] }) });
  assert.equal(roomRenamed.stop.length, 2);
});

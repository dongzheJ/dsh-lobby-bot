/**
 * 驱动名单的差分：把"现在跑着的 (bot, room) 流"对齐到"配置里应该跑的"。
 *
 * 插件最初只在启动时读一次名单，于是"新建一个 bot"必须重启宿主才生效——而 `/lobby <url> <token>`
 * 的全部意义就是不要重启任何东西。这里把对齐规则抽成纯函数：新增要开流、消失要关流、
 * 影响行为的字段变了要重开流（改 token、改房间、改模式都要重新连）。
 * @module dsh-lobby-bot/roster-diff
 */

/**
 * 影响"这个 (bot, room) 流怎么跑"的字段指纹。
 *
 * 只要指纹没变，就把现有流留着——重连会丢掉 `Last-Event-ID`，而断线重放正是靠它。
 * @param entry - `{bot, room}`。
 * @returns 稳定的字符串指纹。
 */
export function fingerprintOf({ bot, room }) {
  return JSON.stringify([
    bot.id,
    bot.nick,
    bot.driver,
    bot.mode,
    bot.minIntervalMs,
    bot.maxBotChain,
    bot.queueLimit,
    bot.promptTimeoutMs,
    bot.workspace,
    bot.persona,
    // The lobby-rendered capability manual changes when the lobby gains an
    // endpoint, changes its cron timezone, or rotates the exchange secret. The
    // whole point of the manual living server-side is that such a change reaches
    // the bot without a plugin release, so it must be part of the fingerprint.
    bot.manual,
    bot.contextDigest?.maxMessages ?? null,
    bot.contextDigest?.maxBytes ?? null,
    room.id,
    room.name,
  ]);
}

/** `(botId, roomId)` 的稳定键。 */
export function pairKey(botId, roomId) {
  return `${botId}/${roomId}`;
}

/**
 * 把期望名单展开成 `(bot, room)` 条目。
 * @param roster - {@link loadRoster} 的返回值。
 * @returns 条目列表。
 */
export function expandRoster(roster) {
  const entries = [];
  for (const bot of roster.bots) {
    for (const roomId of bot.rooms) {
      const room = roster.rooms.find((candidate) => candidate.id === roomId);
      if (room === undefined) continue;
      entries.push({ key: pairKey(bot.id, roomId), bot, room });
    }
  }
  return entries;
}

/**
 * 计算要把现状对齐到期望名单所需的动作。
 * @param options - 输入。
 * @param options.active - 现在跑着的条目：`[{key, fingerprint}]`。
 * @param options.next - 期望的条目：{@link expandRoster} 的输出。
 * @returns `{start, stop}`：`stop` 是要关掉的 key，`start` 是要开的新条目。
 */
export function diffRoster({ active, next }) {
  const activeByKey = new Map(active.map((entry) => [entry.key, entry]));
  const nextKeys = new Set(next.map((entry) => entry.key));
  const stop = [];
  const start = [];

  for (const entry of active) {
    if (!nextKeys.has(entry.key)) {
      stop.push(entry.key);
      continue;
    }
    const wanted = next.find((candidate) => candidate.key === entry.key);
    const fingerprint = fingerprintOf(wanted);
    if (fingerprint !== entry.fingerprint) {
      // 行为参数变了：关掉重开，比"就地改"简单也更不容易半途不一致。
      stop.push(entry.key);
      start.push({ ...wanted, fingerprint });
    }
  }
  for (const entry of next) {
    if (activeByKey.has(entry.key)) continue;
    if (start.some((candidate) => candidate.key === entry.key)) continue;
    start.push({ ...entry, fingerprint: fingerprintOf(entry) });
  }
  return { start, stop };
}

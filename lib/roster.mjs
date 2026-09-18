/**
 * Who this driver drives: all DSH bots exposed by the lobby, fetched over HTTP.
 *
 * The roster used to be read from the lobby's own configuration files, which only
 * worked when the driver and the lobby were the same machine. After
 * `/lobby <url> <token>` the driver asks the lobby instead
 * (`GET /api/driver/roster`), and the lobby returns the complete collaborative
 * roster available to every authenticated user.
 *
 * Everything the driver needs to run a turn (mode, mentions, persona, queue
 * limits and behavior parameters are resolved by the lobby before it answers, so
 * an absent field never has to be second-guessed on this side.
 * @module dsh-lobby-bot/roster
 */

/**
 * Load the roster this personal token drives.
 * @param options - roster inputs.
 * @param options.baseUrl - the lobby's base URL.
 * @param options.token - the user's personal token.
 * @param options.fetchImpl - fetch implementation (tests inject one).
 * @returns the rooms, the driver's enabled `driver: "dsh"` bots, the lobby's
 * identity and all available bots.
 * @throws when the lobby cannot be reached, refuses the personal token, or speaks a
 * different protocol.
 */
export async function fetchRoster({ baseUrl, token, fetchImpl = fetch }) {
  const response = await fetchImpl(new URL("/api/driver/roster", baseUrl), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  let body;
  try {
    body = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new Error(`roster 不是合法 JSON（HTTP ${response.status}）`);
  }
  if (response.status === 401) throw new Error("凭据已失效，请重新 /lobby <url> <token>");
  if (!response.ok) throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
  const bots = Array.isArray(body.bots) ? body.bots : [];
  return {
    baseUrl,
    token,
    rooms: (Array.isArray(body.rooms) ? body.rooms : []).map((room) => ({
      id: String(room.id),
      name: String(room.name ?? room.id),
      description: typeof room.description === "string" ? room.description : "",
    })),
    bots: bots
      .filter((bot) => bot.enabled !== false && bot.driver === "dsh")
      .map((bot) => ({
        id: String(bot.id),
        nick: String(bot.nick ?? bot.id),
        owner: bot.owner ?? null,
        enabled: bot.enabled !== false,
        rooms: Array.isArray(bot.rooms) ? bot.rooms.map(String) : [],
        mode: bot.mode === "always" ? "always" : "mention",
        mentions: Array.isArray(bot.mentions) ? bot.mentions.map(String) : [],
        persona: typeof bot.persona === "string" ? bot.persona : "",
        workspace: typeof bot.workspace === "string" ? bot.workspace : "",
        // The lobby-rendered capability manual: token exchange, attachment
        // reading, cron creation. The driver appends it verbatim (after filling
        // in the room placeholder) and never learns a lobby endpoint itself, so
        // a new capability never needs a plugin release.
        manual: typeof bot.manual === "string" ? bot.manual : "",
        color: typeof bot.color === "string" ? bot.color : undefined,
        model: bot.model ?? null,
        reasoningEffort: typeof bot.reasoningEffort === "string" ? bot.reasoningEffort : null,
        minIntervalMs: Number.isInteger(bot.minIntervalMs) ? bot.minIntervalMs : 2_000,
        queueLimit: Number.isInteger(bot.queueLimit) ? bot.queueLimit : 3,
        promptTimeoutMs: Number.isInteger(bot.promptTimeoutMs) ? bot.promptTimeoutMs : 300_000,
        maxBotChain: Number.isInteger(bot.maxBotChain) ? bot.maxBotChain : 3,
        contextDigest: {
          enabled: bot.contextDigest?.enabled !== false,
          maxMessages: Number.isInteger(bot.contextDigest?.maxMessages) ? bot.contextDigest.maxMessages : 12,
          maxBytes: Number.isInteger(bot.contextDigest?.maxBytes) ? bot.contextDigest.maxBytes : 4096,
        },
      })),
    driverLock: body.driverLock ?? null,
  };
}

/**
 * The empty roster used before the first successful login.
 * @param options - identity inputs.
 * @param options.baseUrl - the lobby address, when one is known.
 * @returns a roster no driver can be built from.
 */
export function emptyRoster({ baseUrl = "" } = {}) {
  return { baseUrl, token: "", rooms: [], bots: [], driverLock: null };
}

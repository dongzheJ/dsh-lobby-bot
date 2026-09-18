/**
 * Who drives this lobby's rooms — arbitrated by the lobby, not by a local file.
 *
 * This machine runs more than one DSH host (the Desktop app plus at least one
 * `dsh web`), and every host that loads this plugin would otherwise drive the same
 * rooms: two answers per question, and two writers of one session log. The lock
 * used to be a file with a heartbeat in the lobby's own `data/` directory, which
 * stops working as soon as the driver is on another machine — so the lobby now
 * arbitrates it, and this module is the client of that decision.
 *
 * A driver that does not hold the lock still keeps its command surface:
 * `/lobby <url> <token>` has to work on a host that is not driving, because the room
 * belongs to the lobby, not to this host.
 * @module dsh-lobby-bot/lock
 */

/** How long the lobby waits before it considers a silent driver gone. */
export const STALE_MS = 90_000;

/**
 * One heartbeat: refresh this driver's claim, and learn who holds the lock.
 * @param options - heartbeat inputs.
 * @param options.baseUrl - the lobby's base URL.
 * @param options.token - the user's personal token.
 * @param options.fetchImpl - fetch implementation (tests inject one).
 * @returns `{driving, holder}`; `holder` is a `{driverId, nick, host, heartbeatAt}`
 * record, `null`, or `undefined` when the lobby did not say.
 * @throws when the lobby cannot be reached or refuses the personal token.
 */
export async function heartbeatLock({ baseUrl, token, fetchImpl = fetch }) {
  const response = await fetchImpl(new URL("/api/driver/lock/heartbeat", baseUrl), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (response.status === 401) throw new Error("凭据已失效，请重新 /lobby <url> <token>");
  const text = await response.text();
  let body;
  try {
    body = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new Error(`锁心跳返回的不是合法 JSON（HTTP ${response.status}）`);
  }
  if (!response.ok) throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
  return { driving: body.driver === true, holder: body.holder ?? null };
}

/**
 * A human-readable description of who holds a lock.
 * @param holder - `{driverId, nick, host, heartbeatAt}`.
 * @param now - clock.
 * @returns a short phrase for logs and `/lobby status`.
 */
export function describeHolder(holder, now = Date.now()) {
  if (holder === null || holder === undefined) return "无人持有";
  const seen = typeof holder.heartbeatAt === "number" ? holder.heartbeatAt : undefined;
  const age = seen === undefined ? "" : `，${Math.max(0, Math.round((now - seen) / 1000))}s 前的心跳`;
  return `${holder.nick ?? holder.driverId ?? "未知驱动"}（${holder.driverId ?? "?"}${age}）`;
}

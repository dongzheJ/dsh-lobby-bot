/**
 * `/lobby` 命令的参数解析。
 *
 * 命令面是给人敲的，所以语法要短、要能容错；而解析必须可测——敲错一个词不该变成"什么都没发生"。
 * 语法：
 *
 *   /lobby <url> <token> [昵称] [id=<ascii>]  登录 + 把当前工作区接成我的机器人（一步到位）
 *   /lobby login <url> <token>                 只登录，不接机器人
 *   /lobby logout                              退出并清除本机凭据
 *   /lobby status                              登录状态、目标、锁、流
 *   /lobby target                              只打印当前目标 URL
 *   /lobby list
 *   /lobby leave <昵称|id>
 *
 * 参数按位置与 `key=value` 混排，昵称可以带空格（用引号时按引号切，否则按第一个 key=value 之前的部分）。
 * `<url>` 与 `<token>` 都是位置参数：按形状识别——地址按 `looksLikeUrl` 认，凭据按 `tk_` 前缀认，
 * 两者都必有其一，所以顺序可以随便换，`url=` / `token=` 也好写。
 * @module dsh-lobby-bot/command-input
 */

/** 拆词：先按空白切，引号内的空白保留（昵称里可能有空格）。 */
function tokenize(input) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

/** 这个位置参数看起来是不是一个地址（`host:port`、`http://…`、`https://…`）。 */
function looksLikeUrl(token) {
  if (/^https?:\/\//i.test(token)) return true;
  // `192.168.1.9:8770` / `localhost:8770`：有端口、且不含空白与凭据里常见的 `_`/`-` 分隔花活。
  return /^[a-z0-9.-]+(:\d+)(\/.*)?$/i.test(token);
}

/** 已注册的子命令；第一个词不是它们时，整行按 `/lobby <url> <token>` 解析。 */
const SUBCOMMANDS = new Set(["connect", "login", "logout", "list", "leave", "status", "target", "help", "join"]);

/**
 * 从位置参数与 `key=value` 里取出「地址 + 凭据 + 昵称 + id」。
 * @param parsed - 已解析出的选项与位置参数。
 * @returns `{url, token, nick?, id?}` 或带 `error` 的用法提示。
 */
function takeLogin({ options, positional }) {
  const urlIndex = positional.findIndex((value) => looksLikeUrl(value));
  const tokenIndex = positional.findIndex((value) => value.startsWith("tk_"));
  const url = options.url ?? (urlIndex >= 0 ? positional[urlIndex] : undefined);
  const token = options.token ?? (tokenIndex >= 0 ? positional[tokenIndex] : undefined);
  const rest = positional.filter((_, index) => index !== urlIndex && index !== tokenIndex);
  const nick = rest.join(" ").trim();
  return {
    url,
    token,
    ...(nick.length === 0 ? {} : { nick }),
    ...(options.id === undefined ? {} : { id: options.id }),
  };
}

/**
 * 解析 `/lobby` 之后的输入。
 *
 * 第一个词不是已知子命令时有两种可能：裸形式（`/lobby <url> <token>`，每一步都要用到的那个）
 * 或者敲错了。按形状判断——像地址就按裸形式走，否则报未知子命令并给出帮助文本。
 * @param rawInput - 命令名之后、逐字保留的输入（可能带前导空格）。
 * @returns `{action, nick?, id?, url?, token?, target?, error?}`。
 */
export function parseLobbyCommand(rawInput) {
  const tokens = tokenize(String(rawInput ?? ""));
  if (tokens.length === 0) return { action: "help" };
  const head = tokens[0];
  const bare = !SUBCOMMANDS.has(head.toLowerCase());
  const action = bare ? "connect" : head.toLowerCase();
  const options = {};
  const positional = [];
  // 裸形式下第一个词也是这条命令的参数（`/lobby http://host:8770 tk_xxx`、`/lobby url=… token=…`）。
  for (const token of bare ? tokens : tokens.slice(1)) {
    const eq = token.indexOf("=");
    if (eq > 0) {
      const key = token.slice(0, eq).toLowerCase();
      const value = token.slice(eq + 1);
      if (key === "id") options.id = value;
      else if (key === "rooms" || key === "room") return { action, error: "bot 不绑定房间；房间在网页侧栏把它「加入」即可" };
      else if (key === "url") options.url = value;
      else if (key === "token") options.token = value;
      else return { action, error: `未知参数 ${key}=…（支持 id= / url= / token=）` };
    } else {
      positional.push(token);
    }
  }

  switch (action) {
    case "connect":
    case "login": {
      const taken = takeLogin({ options, positional });
      if (taken.url === undefined || !looksLikeUrl(taken.url)) {
        return { action, error: bare ? "用法：/lobby <url> <token>" : "用法：/lobby login <url> <token>" };
      }
      if (taken.token === undefined || taken.token.length === 0) {
        return { action, error: "缺少凭据：个人 token 形如 tk_…（注册后在网页「我的 token」里拿）" };
      }
      return { action, ...taken };
    }
    case "join":
      // 这个子命令已经并进裸形式，留着只会让人以为还有第二种接法。
      return { action: "help", error: "join 已经不需要了：直接写 /lobby <url> <token>" };
    case "logout":
    case "target":
    case "list":
    case "status":
    case "help":
      return { action, ...options };
    case "leave": {
      const target = positional.join(" ").trim();
      if (target.length === 0) return { action, error: "用法：/lobby leave <昵称|id>" };
      return { action, target, ...options };
    }
    default:
      return { action: "help", error: `未知子命令 ${JSON.stringify(action)}` };
  }
}

/** 命令面的帮助文本。 */
export const LOBBY_HELP = [
  "/lobby <url> <token> [昵称] [id=<ascii>]   登录并把当前工作区接成我的机器人",
  "/lobby login <url> <token>                只登录，不接机器人",
  "/lobby logout                              退出并清除本机凭据",
  "/lobby list                                我名下的机器人与所在房间",
  "/lobby leave <昵称|id>                     从房间摘掉它（工作目录与会话都保留）",
  "/lobby status                              登录状态、目标、驱动锁",
  "/lobby target                              只打印当前目标 URL",
].join("\n");


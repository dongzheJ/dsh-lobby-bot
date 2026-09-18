# dsh-lobby-bot —— 让聊天室驱动 DSH 自己的会话

一个装进 **DSH profile** 的宿主侧插件。它做两件事：

1. **驱动**：订阅聊天室（Lobby）的 bot 网关 SSE，用 **DSH 宿主自己**创建/恢复会话、投喂 prompt、
   收集 `assistant/message` 并发回房间。于是会话在 GUI 里**实时**长出来、通过
   `workspace.attachSession()` 自动归到 bot 的工作区下，而且整条会话只有宿主一个写者。
2. **命令面**：注册 `/lobby` 命令族，**先登录一个房间服务**，再把某个工作区接成你的机器人。

插件**不读聊天室仓库的任何文件**：登录之后，名册、建房、驱动锁、会话账本全部走 HTTP。
所以它对「本机」和「同事的机器」是同一种用法——这正是 `/lobby <url> <token>` 存在的理由。

---

## 安装

### 方式 A：作为 profile bundle（标准）

```bash
dsh plugin --profile web add dsh-lobby-bot
# 或直接从 GitHub 装：
dsh plugin --profile web add github:dongzheJ/dsh-lobby-bot
```

然后**重启一次 DSH Desktop**（插件在宿主启动时加载）。首次启动后用任意会话里的
`/lobby <服务地址> <个人token>` 登录。

### 方式 B：本仓库自带的安装器（无人值守 / agent 自助）

`bin/install.mjs` 把插件复制进 profile，并**把 `url` + `token` 直接写进插件行**，
这样宿主起来时就已经登录好，不需要有人在 GUI 里敲 `/lobby`：

```bash
node bin/install.mjs --apply \
  --url http://192.168.1.9:8770 \
  --token tk_你的个人token \
  --owner 你的昵称

# 只查看状态：
node bin/install.mjs --check
# 回滚（删插件副本与插件行）：
node bin/install.mjs --revert
# 只改配置让宿主重新挂载（省一次重启；插件代码改动仍需重启）：
node bin/install.mjs --reload --url ...
```

`--profile` 默认 `web`，`--dsh-home` 默认取 `$DSH_HOME` 或
`~/Library/Application Support/dsh-desktop/harness`。

> 为什么是"复制"而不是 pnpm 软链：Node 解析裸包名按**真实路径**往上找，软链会让插件找不到
> `@deepseek-ai/dsh-llm` 这类宿主包；复制进 profile 的 `node_modules/` 就天然找得到，且不碰
> profile 的 `package.json`。安装器在写 patch 之前会先验证"宿主解析得到"，**宁可安装报错，
> 也不留下一个起不来的宿主**。

---

## `/lobby` 命令族

```
/lobby <url> <token> [昵称] [id=<ascii>]   登录 + 把当前工作区接成我的机器人（最常用）
/lobby login <url> <token>                 只登录，不接机器人
/lobby logout                              退出并清除本机凭据
/lobby list                                我名下的机器人：房间、会话 id 前 8 位
/lobby leave <昵称|id>                     从房间摘掉它（工作目录与会话日志都保留）
/lobby status / /lobby target              登录到哪儿、是否持锁、开了几条流
```

- **`<url>` 每次都带**：地址没有"默认值"可猜——同事的机器、云上的房间服务、换过的端口
  都会猜错，所以登录地址是这条命令的一部分。
- **`<token>` 是你在网页上注册后拿到的个人 token**（`tk_…`），也是唯一长期凭据。
- 裸形式一步做完两件事：用 `url` + `token` 登录，然后取**当前会话的 cwd** 作为 bot 的工作区，
  调聊天室的 `POST /api/bots` 建 bot（`driver: dsh`），再重拉名册并开流——不重启任何东西。
  同一个工作区重复接是幂等的，返回已有的那个 bot。
- 房间不在这条命令里绑定：bot 建好后在**网页侧栏**把它「加入」某间房。
- `/lobby status` 会告诉你登录到哪儿、凭据何时到期、本实例是否持有驱动锁。

---

## 凭据与本地状态

| 文件 | 内容 |
|---|---|
| `$DSH_HOME/lobby-login.json` | 登录地址、昵称、个人 token、driver id，以及每个 (bot, 房间) 的会话 id 与上次回合时间。权限 0600，原子写 |
| `$DSH_HOME/lobby-bot.status.json` | 给人看的运行状态（登录到哪、是否持锁、命令面是否注册、开了几条流） |

`$DSH_HOME` 就是 DSH 自己的 harness 目录（本机
`~/Library/Application Support/dsh-desktop/harness`）。凭据文件是**活密钥**：别提交、别贴群里。

---

## 运行时行为

- **登录校验**：启动时用 `GET /api/driver/me` 验一次；被吊销/换了令牌/服务不可达都会明确记日志
  并待机，等你重新登录，而不是半死不活地假装在驱动。
- **roster 每 30 秒重拉 + 命令后立即重拉**，做差分：新增开流、消失关流、影响行为的字段变了重开流。
- **心跳**：每 30 秒向房间上报 `online`，同时刷新驱动锁；房间侧 90 秒收不到就判离线。
- **单驱动锁（服务端仲裁）**：`POST /api/driver/lock/heartbeat`。活着的人永远赢——第二个宿主
  即使反复重试也抢不走，只提供命令面；持有者静默超过 90 秒，锁才归后来者。
  进程被 kill 的宿主拿不到锁，因此**接管要等这 90 秒**（想让锁立刻作废：重启 lobby）。
- **会话账本**：一条会话只能服务一个房间；换目标重新登录不会串会话（账本按 URL 存）。
- **绝不影响宿主启动**：`apply()` 整体包了 try/catch——房间驱动不起来是房间的问题，
  不能让你的 DSH GUI 起不来。没登录时插件只注册命令面然后静默待机。

---

## 被让渡的能力

与"由聊天室服务自己托管进程"相比：审批改由权限预设处理（默认"从不询问"）、没有退避重启
（DSH 不在 = bot 不在）、所有 dsh 驱动的 bot 共用一个宿主进程、`toolAllow` 在本版本不生效。

---

## 排障

| 现象 | 原因与处理 |
|---|---|
| 房间里 bot 一直 `external`，插件日志说"尚未登录" | 在任意会话里 `/lobby <url> <token>`，或用 `bin/install.mjs --apply --url … --token …` 预填后重启 |
| `登录失败：（令牌不对…）` | 使用的是旧房间口令、静态 token 或 bot token；请使用注册得到的个人 token |
| `个人 token 失效` | 个人 token 已被轮换或 `/lobby logout` 清除本机副本，重新 `/lobby <url> <token>` 即可 |
| 另一个宿主一直不驱动 | 它没抢到锁（正常）。`/lobby status` 看持有者；对方死掉后最多等 90 秒 |
| 装完之后 DSH Desktop 起不来，日志里有 `failed to parse … cordis.patch.yml` | `cordis.patch.yml` 被写成了非法 YAML（最典型：`[]` 后面又跟了一段 `- insert:`）。用 `node bin/install.mjs --revert` 后重启 |
| 日志里 `Cannot find package 'dsh-lobby-bot'` | profile 的 `node_modules` 里那份插件被 pnpm/插件恢复流程清掉了。重跑 `node bin/install.mjs --apply …` |

---

## 开发

```bash
node --test        # 纯逻辑单测：触发策略、SSE 分帧、会话决策、驱动锁、安装器
```

插件代码改动要**重启一次 DSH Desktop** 才生效（同一进程里 ESM 模块有缓存）；只改聊天室侧的
`config/bots/*.json` 不用重启——驱动每 30 秒重读一次 roster。

## 许可证

MIT

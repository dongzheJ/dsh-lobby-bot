#!/usr/bin/env node
/**
 * Install this plugin into a DSH profile, optionally pre-filling the lobby login.
 *
 * The standard `dsh plugin --profile web add dsh-lobby-bot` route mounts the row
 * from `cordis.patch.yml`, and the user then logs in with `/lobby <url> <token>`.
 * This script is the headless/agent route: it copies the package into the profile
 * and writes the row **with `url` + `token` already in place**, so a host that
 * never sees a human can come up already logged in.
 *
 * Copying (rather than pnpm-linking) is deliberate: Node resolves a bare package
 * name by its *real path*, so a symlinked plugin cannot find `@deepseek-ai/dsh-llm`
 * among the host's packages. A copy under the profile's own `node_modules` can.
 *
 * Three rules: back up every file before editing it; `--revert` restores the
 * profile exactly; and never write a patch layer the host cannot parse. DSH writes
 * a fresh profile's `cordis.patch.yml` as a comment header plus `[]`, and
 * appending `- insert:` after that flow sequence is invalid YAML that stops the
 * host from booting — so an empty layer is replaced, never appended to. The
 * package is also proven resolvable before the patch is touched.
 *
 * A restart of DSH Desktop is required after installing (the host loads plugins at
 * startup).
 * @module dsh-lobby-bot/install
 */
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** This plugin package's root (the directory holding `package.json`). */
const PACKAGE_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** The harness home DSH Desktop uses when `DSH_HOME` is unset. */
export function defaultDshHome() {
  return process.env.DSH_HOME ?? path.join(homedir(), "Library/Application Support/dsh-desktop/harness");
}

/** Marks the block this tool owns inside the profile patch. */
const BLOCK_START = "# ── lobby-bot（由 dsh-lobby-bot/bin/install.mjs 管理，勿手改）──";

/**
 * Render a value as a YAML scalar.
 *
 * JSON's double-quoted scalar is a subset of YAML's, so `JSON.stringify` output
 * always reads back as the same string and dodges every bare-scalar trap: a token
 * or URL containing `#`, `: `, a leading `-*&%{[!|>?@`, or trailing space would
 * otherwise break the whole patch file — not "a wrong config", a host that will
 * not start.
 * @param value - any scalar.
 * @returns the quoted YAML scalar.
 */
function yamlScalar(value) {
  return JSON.stringify(String(value));
}

/**
 * Read one scalar this tool wrote (tolerating older bare values).
 * @param text - patch text.
 * @param key - config key.
 * @returns the unquoted value, or `undefined`.
 */
function readScalar(text, key) {
  const prefix = `${key}:`;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(prefix)) continue;
    const raw = trimmed.slice(prefix.length).trim();
    if (!raw.startsWith('"')) return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return raw.replace(/^"|"$/g, "");
    }
  }
  return undefined;
}

/**
 * Whether a patch text, ignoring comments and blanks, is just an empty array.
 *
 * DSH writes a fresh profile's `cordis.patch.yml` as a comment header plus `[]`
 * (see `@deepseek-ai/dsh-app-boot`'s `PROFILE_PATCH_TEMPLATE`); Safe Mode resets it
 * the same way. That is an empty *layer*, and appending a block to it produces
 * invalid YAML.
 * @param text - patch text.
 * @returns whether the layer is empty.
 */
function isEmptyLayer(text) {
  const significant = text
    .split("\n")
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (significant.length === 0) return true;
  return significant.length === 1 && /^\[\s*\]$/.test(significant[0]);
}

/**
 * Merge this tool's block into the user's patch layer.
 *
 * Two cases: a layer with other entries gets the block appended (YAML allows
 * several entries per layer); an empty layer (`[]`) has that line replaced,
 * because `[]` followed by `- insert:` does not parse.
 * @param patchText - existing patch text.
 * @param block - the block from {@link blockFor}, marker line included.
 * @returns the merged file content.
 */
export function composeLayer(patchText, block) {
  const withoutBlock = stripBlock(patchText);
  const trimmed = withoutBlock.replace(/\s*$/, "");
  if (!isEmptyLayer(trimmed)) return `${trimmed}\n${block}`;
  const comments = trimmed
    .split("\n")
    .filter((line) => line.trim() !== "[]")
    .join("\n")
    .replace(/\s*$/, "");
  return `${comments}\n${block}`;
}

/** Where a top-level entry (`- …`) ends. */
function topLevelEnd(lines, start) {
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "" || line.startsWith(" ") || line.startsWith("\t")) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

/** Whether a top-level entry is this plugin's row (matched by `name:`). */
function ownsRow(item) {
  return /^\s*name:\s*['"]?dsh-lobby-bot['"]?\s*$/m.test(item);
}

/**
 * The exact patch block appended to the profile's own layer.
 *
 * `url` + `token` are a pre-filled login: the plugin presents the token at
 * startup, and everything after that — roster, registering a bot, the driver lock
 * — is fetched over HTTP with it. The token is the person's **personal token**, so
 * bots registered from this machine belong to them.
 * @param options - block inputs.
 * @param options.url - the lobby address to log in to.
 * @param options.token - the personal token, or `""` to log in later.
 * @param options.owner - the room nickname whose bots are created from this Mac.
 * @param options.reloadedAt - timestamp that forces a remount.
 * @returns the YAML block, including its marker line.
 */
function blockFor({ url, token, owner, reloadedAt }) {
  return [
    "",
    BLOCK_START,
    "- insert:",
    "    - id: lobby-bot",
    "      name: 'dsh-lobby-bot'",
    "      config:",
    `        url: ${yamlScalar(url)}`,
    ...(token === undefined || token.length === 0 ? [] : [`        token: ${yamlScalar(token)}`]),
    ...(owner === undefined || owner === null ? [] : [`        owner: ${yamlScalar(owner)}`]),
    "        permissionPresets:",
    "          - lobby-bot-workspace",
    "          - danger-full-access",
    ...(reloadedAt === undefined ? [] : [`        reloadedAt: ${yamlScalar(reloadedAt)}`]),
    "",
  ].join("\n");
}

/**
 * The text of the block this tool owns, or `""`.
 *
 * Every field is read from inside this block rather than from the whole patch: a
 * profile patch holds other plugins' config too, and `url:` / `owner:` are exactly
 * the kind of key they use.
 * @param patchText - the whole patch file.
 * @returns the owned block, marker line included.
 */
function ownedBlock(patchText) {
  const lines = patchText.split("\n");
  const markerIndex = lines.findIndex((line) => line.trim() === BLOCK_START);
  if (markerIndex >= 0) {
    const head = [];
    let index = markerIndex;
    while (index < lines.length) {
      const line = lines[index];
      if (index !== markerIndex && line.trim() !== "" && !line.trim().startsWith("#")) break;
      head.push(line);
      index += 1;
    }
    if (index < lines.length && lines[index].startsWith("- ")) {
      return [...head, ...lines.slice(index, topLevelEnd(lines, index))].join("\n");
    }
    return head.join("\n");
  }
  // Fallback: a hand-written row with no marker comment.
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith("- ")) continue;
    const end = topLevelEnd(lines, index);
    const item = lines.slice(index, end).join("\n");
    if (ownsRow(item)) return item;
    index = end - 1;
  }
  return "";
}

/** Read back the `owner` configured in an existing patch. */
function ownerIn(patchText) {
  return readScalar(ownedBlock(patchText), "owner");
}

/** Read back the login `url` configured in an existing patch. */
function urlIn(patchText) {
  return readScalar(ownedBlock(patchText), "url");
}

/**
 * Read the plugin's own status file, so "is it alive / where is it logged in" is
 * answerable from a terminal instead of the GUI.
 * @param dshHome - the harness home.
 * @returns a one-line summary.
 */
function runtimeLine(dshHome) {
  const file = path.join(dshHome, "lobby-bot.status.json");
  try {
    const status = JSON.parse(readFileSync(file, "utf8"));
    const age = Math.round((Date.now() - Date.parse(status.updatedAt)) / 1000);
    const where = status.loggedIn === true ? `登录=${status.url}（${status.owner ?? "?"}）` : "登录=未登录";
    return `${where} · pid ${status.pid} · 驱动=${status.driving === true ? "是" : "否"} · /lobby=${status.commandsRegistered === true ? "已注册" : "未注册"} · 流 ${status.streams?.length ?? 0} 个 · ${age}s 前更新`;
  } catch {
    return "（还没有状态文件：插件没在这个宿主里跑过，或还没走到写状态那一步）";
  }
}

/**
 * Absolute paths this tool touches.
 * @param options - overrides.
 * @param options.dshHome - the harness home.
 * @param options.profile - the profile name (default `web`).
 * @returns the resolved paths.
 */
export function layout({ dshHome = defaultDshHome(), profile = "web" } = {}) {
  const profileDir = path.join(dshHome, "profiles", profile);
  return {
    dshHome,
    profile,
    profileDir,
    target: path.join(profileDir, "node_modules", "dsh-lobby-bot"),
    patchFile: path.join(profileDir, "cordis.patch.yml"),
  };
}

/** Whether a path exists. */
async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the host can actually `import` the plugin once copied.
 *
 * Not paranoia: DSH's loader first imports by its own location, then falls back to
 * `createRequire(<profile>/package.json).resolve(name)`; when both fail the host
 * throws `Cannot find package 'dsh-lobby-bot'` and will not start. So this is
 * checked before the patch is touched — better to fail the install than to leave a
 * host that cannot boot.
 * @param profileDir - `…/profiles/web`.
 * @returns `{applicable, ok}`; `applicable:false` when there is no profile manifest.
 */
function resolutionCheck(profileDir) {
  const manifest = path.join(profileDir, "package.json");
  if (!existsSync(manifest)) return { applicable: false, ok: true };
  try {
    createRequire(manifest).resolve("dsh-lobby-bot");
    return { applicable: true, ok: true };
  } catch {
    return { applicable: true, ok: false };
  }
}

/** ISO timestamp safe for a file name. */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Inspect the current installation.
 * @param options - layout overrides.
 * @returns what is installed and what is missing.
 */
export async function inspect(options = {}) {
  const paths = layout(options);
  const patchText = await readFile(paths.patchFile, "utf8").catch(() => "");
  return {
    ...paths,
    packageExists: await exists(PACKAGE_DIR),
    installed: await exists(paths.target),
    resolvable: (await exists(paths.target)) && resolutionCheck(paths.profileDir).ok,
    rowPresent: ownsRow(patchText),
    owner: ownerIn(patchText),
    url: urlIn(patchText),
    profileExists: await exists(paths.profileDir),
  };
}

/**
 * Install (or refresh) the plugin copy and its row.
 * @param options - layout and login overrides.
 * @returns what changed.
 */
export async function install(options = {}) {
  const state = await inspect(options);
  if (!state.profileExists) throw new Error(`找不到 profile：${state.profileDir}`);
  const url = options.url ?? state.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(
      "缺少 --url（房间服务地址）。\n" +
        "  例如：node bin/install.mjs --apply --url http://127.0.0.1:8770 --token <你的个人 token>",
    );
  }
  const token = options.token;
  const owner = options.owner ?? state.owner;
  const changes = [];

  await rm(state.target, { recursive: true, force: true });
  await mkdir(path.dirname(state.target), { recursive: true });
  await cp(PACKAGE_DIR, state.target, { recursive: true });
  if (!resolutionCheck(state.profileDir).ok) {
    throw new Error(
      `插件已复制到 ${state.target}，但宿主解析不到它（Cannot find package 'dsh-lobby-bot'）。\n` +
        "  这种情况下写 patch 只会让 DSH Desktop 起不来，所以这次没有改动 patch 层。",
    );
  }
  changes.push(`复制 ${PACKAGE_DIR} → ${state.target}`);

  const patchText = await readFile(state.patchFile, "utf8").catch(() => "");
  const ownerChanged = options.owner !== undefined && state.owner !== options.owner;
  const loginChanged = options.url !== undefined || options.token !== undefined;
  const reloadedAt = options.reload === true ? new Date().toISOString() : undefined;
  if (!state.rowPresent || ownerChanged || loginChanged || reloadedAt !== undefined) {
    const backup = `${state.patchFile}.bak-${stamp()}`;
    if (patchText.length > 0) await writeFile(backup, patchText, "utf8");
    await writeFile(
      state.patchFile,
      composeLayer(patchText, blockFor({ url, token, owner, ...(reloadedAt === undefined ? {} : { reloadedAt }) })),
      "utf8",
    );
    changes.push(
      `${state.rowPresent ? "更新" : "追加"} row 到 ${state.patchFile}（登录 ${url}${owner === undefined ? "" : `，owner=${owner}`}）${patchText.length > 0 ? `（备份 ${path.basename(backup)}）` : ""}`,
    );
  } else {
    changes.push("row 已存在且未变，未重复插入");
  }
  return { ...(await inspect(options)), changes };
}

/**
 * Remove this tool's block from a patch text.
 *
 * Two paths together: the marker comment section, and any top-level entry whose
 * `name:` is `dsh-lobby-bot`. Marker-only is not enough — the row may have been
 * hand-written or the comment rewritten, and a duplicate `id: lobby-bot` makes DSH
 * refuse to start (`duplicate loader entry id`).
 * @param patchText - existing patch text.
 * @returns the text without this tool's content.
 */
export function stripBlock(patchText) {
  const lines = patchText.split("\n");
  const kept = [];
  let pending = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === BLOCK_START) {
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        if (next.trim() === "" || next.startsWith(" ")) index += 1;
        else break;
      }
      pending = pending.filter((candidate) => candidate.trim() !== "");
      continue;
    }
    if (line.startsWith("- ")) {
      const end = topLevelEnd(lines, index);
      if (ownsRow(lines.slice(index, end).join("\n"))) {
        index = end - 1;
        continue;
      }
      kept.push(...pending, line);
      pending = [];
      continue;
    }
    if (line.trim() === "" || line.trim().startsWith("#")) {
      pending.push(line);
      continue;
    }
    kept.push(...pending, line);
    pending = [];
  }
  kept.push(...pending);
  return kept.join("\n");
}

/**
 * Remove the plugin copy and its row.
 * @param options - layout overrides.
 * @returns what changed.
 */
export async function revert(options = {}) {
  const state = await inspect(options);
  const changes = [];
  if (state.installed) {
    await rm(state.target, { recursive: true, force: true });
    changes.push(`删除 ${state.target}`);
  }
  const patchText = await readFile(state.patchFile, "utf8").catch(() => "");
  if (patchText.includes(BLOCK_START) || ownsRow(patchText)) {
    const backup = `${state.patchFile}.bak-${stamp()}`;
    await writeFile(backup, patchText, "utf8");
    const remaining = stripBlock(patchText).replace(/\s*$/, "");
    const body = isEmptyLayer(remaining)
      ? `${remaining.split("\n").filter((line) => line.trim() !== "[]").join("\n").replace(/\s*$/, "")}\n[]`
      : remaining;
    await writeFile(state.patchFile, `${body.replace(/^\n+/, "")}\n`, "utf8");
    changes.push(`从 ${state.patchFile} 移除 row（备份 ${path.basename(backup)}）`);
  }
  return { changes };
}

/** CLI entry. */
async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const revertRequested = argv.includes("--revert");
  const check = argv.includes("--check") || (!apply && !revertRequested);
  const reload = argv.includes("--reload");
  const valueOf = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const owner = valueOf("--owner");
  const url = valueOf("--url");
  const token = valueOf("--token");
  const profile = valueOf("--profile");
  const dshHome = valueOf("--dsh-home");
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      "用法：node bin/install.mjs [--check | --apply | --revert] [--url <房间服务地址>] [--token <个人token>] [--owner <昵称>] [--profile web] [--dsh-home <路径>] [--reload]\n" +
        "  --url/--token  登录并预填到插件行；token 是你自己的个人 token（网页「我的 token」里拿）\n" +
        "  --check   只报告当前状态（默认）\n" +
        "  --apply   复制插件到 profile 并写入插件行（改完要重启 DSH Desktop）\n" +
        "  --revert  删除插件副本与插件行（同样要重启）\n" +
        "  --reload  只改一下 row 配置（reloadedAt）让宿主重新挂载插件；插件代码改动仍要重启\n",
    );
    return;
  }
  const options = { ...(profile === undefined ? {} : { profile }), ...(dshHome === undefined ? {} : { dshHome }) };
  try {
    if (revertRequested) {
      const result = await revert(options);
      process.stdout.write(`${result.changes.map((line) => `✅ ${line}`).join("\n") || "没有需要还原的东西"}\n\n重启一次 DSH Desktop 生效。\n`);
      return;
    }
    if (reload) {
      const result = await install({ ...options, owner, url, token, reload: true });
      process.stdout.write(`${result.changes.map((line) => `✅ ${line}`).join("\n")}\n\n几秒后插件会重新挂载并按新配置工作。\n`);
      return;
    }
    if (check) {
      const state = await inspect(options);
      process.stdout.write(
        [
          `插件包       ${state.packageExists ? "✅" : "❌"} ${PACKAGE_DIR}`,
          `已装进 profile ${state.installed ? "✅" : "❌"} ${state.target}`,
          `宿主可解析    ${state.resolvable ? "✅" : "❌"}（❌ 时 DSH Desktop 会因 Cannot find package 起不来，重跑 --apply）`,
          `插件行       ${state.rowPresent ? "✅" : "❌"} ${state.patchFile}`,
          `登录地址     ${state.url ?? "（未配置：装好后在任意会话里 /lobby <服务地址> <个人token>）"}`,
          `我的昵称     ${state.owner ?? "（未设置：昵称默认取当前工作区文件夹名）"}`,
          `插件运行状态 ${runtimeLine(state.dshHome)}`,
          state.installed && state.resolvable && state.rowPresent ? "\n状态：已安装（若刚改过，需要重启 DSH Desktop 才生效）" : "\n状态：未装齐，跑 --apply",
        ].join("\n") + "\n",
      );
      return;
    }
    const result = await install({ ...options, owner, url, token });
    process.stdout.write(
      `${result.changes.map((line) => `✅ ${line}`).join("\n")}\n\n` +
        "下一步：**重启一次 DSH Desktop**（插件在宿主启动时加载）。\n" +
        "回滚：node bin/install.mjs --revert 后再重启。\n",
    );
  } catch (error) {
    process.stderr.write(`安装失败：${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}

// Importable for tests without running the CLI.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}

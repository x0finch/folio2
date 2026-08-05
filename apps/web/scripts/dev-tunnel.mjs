#!/usr/bin/env node
// 在手机上测这个 app:起 Cloudflare 隧道 + server,两个一起停。
//
//   pnpm dev:tunnel              # dev server,可热更新
//   pnpm dev:tunnel --preview    # 构建产物;手机上快得多(dev 不打包,隧道下要发 ~250 个模块请求,
//                                # 每个 ~130ms → 页面 350ms 就画出来了但 3 秒多才点得动)
//
// 域名有两个去处:
// ① DEV_ALLOWED_HOST 传给 vite —— 放通 host 白名单(vite 默认只认 localhost)。
// ② .dev.vars 里的 BETTER_AUTH_URL —— **运行期临时改掉,退出时还原**。passkey 的 rpID 从它派生,
//    不跟着换手机上每个 ceremony 都会 rpID 不匹配;而 worker 的环境变量只能来自 wrangler 配置或
//    这个文件,普通环境变量进不去,所以只能改文件。原文另存一份在系统临时目录(不在仓库里),被
//    硬杀(SIGKILL)来不及还原时,下次启动会拿它还原回去。
//
// 还原都是**有条件**的:备份的文件名带着「我们写进去的那份内容」的散列,还原前先比一下文件现在是不是
// 还正好是那份。不是就说明你之后自己改过 —— 那就不动,只把备份路径打出来。宁可留个手工收尾,也不
// 能把人的改动盖掉。
//
// 注:--preview 模式下构建产物里那份 .dev.vars 快照留的是隧道地址,下次 build 才会刷掉。
//
// 默认起随机的 trycloudflare 域名:能用,但每次都变 → rpID 变,手机上得重新注册 passkey。想固定就
// 建命名隧道(一次性,需要一个挂在 Cloudflare 上的域名):
//
//   cloudflared tunnel login && cloudflared tunnel create folio-local
//   cloudflared tunnel route dns folio-local folio-local.你的域名
//
// 然后在 .dev.vars(本地私有、不入库)加两行 —— TUNNEL_NAME=folio-local /
// TUNNEL_HOSTNAME=https://folio-local.你的域名 —— 或者直接用环境变量传进来。

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const WEB_ROOT = new URL("..", import.meta.url);
const DEV_VARS = fileURLToPath(new URL(".dev.vars", WEB_ROOT));
const PORT = process.env.PORT ?? "3000";
const usePreview = process.argv.includes("--preview");

function sha(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// 备份放系统临时目录(永远不在仓库里),文件名 = 仓库路径散列 + **我们写进 .dev.vars 的那份内容**的
// 散列。后半截是「还原凭证」:还原前先看文件现在是不是还正好是那份内容,不是就说明之后有人改过 ——
// 那就别动,免得把人家的改动盖掉。多个 checkout 各自一份,互不干扰。
const STASH_PREFIX = `folio-dev-vars-${sha(DEV_VARS).slice(0, 8)}-`;
const stashPath = (contentHash) => join(tmpdir(), STASH_PREFIX + contentHash);

function listStashes() {
  try {
    return readdirSync(tmpdir()).filter((f) => f.startsWith(STASH_PREFIX));
  } catch {
    return [];
  }
}

function readDevVars() {
  try {
    return readFileSync(DEV_VARS, "utf8");
  } catch {
    return null;
  }
}

// 上一轮被硬杀了 → 只在文件仍是我们留下的那份内容时才还原。
function recoverStash() {
  const leftovers = listStashes();
  if (!leftovers.length) return;
  const current = readDevVars();
  const mine =
    current === null
      ? undefined
      : leftovers.find((f) => f.slice(STASH_PREFIX.length) === sha(current));
  if (!mine) {
    console.log(".dev.vars 和上一轮留下的备份对不上(之后被改过?)—— 不动它。原文在:");
    for (const f of leftovers) console.log(`  ${join(tmpdir(), f)}`);
    return;
  }
  writeFileSync(DEV_VARS, readFileSync(join(tmpdir(), mine), "utf8"));
  // 文件回到了已知状态,别的残留备份就都过期了。
  for (const f of leftovers) rmSync(join(tmpdir(), f), { force: true });
  console.log("上一轮没正常退出,已把 .dev.vars 还原回去。");
}

recoverStash();

// 只读几个键,不碰文件里别的东西。显式环境变量优先。
function conf(key) {
  const fromEnv = process.env[key];
  if (fromEnv) return fromEnv;
  return (
    readDevVars()
      ?.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]
      ?.trim() || undefined
  );
}

const name = conf("TUNNEL_NAME");
const hostname = conf("TUNNEL_HOSTNAME");
if (name && !hostname) {
  console.error(`TUNNEL_NAME=${name} 还需要 TUNNEL_HOSTNAME(该隧道对应的完整 https 地址)。`);
  process.exit(1);
}

// 改回原样用的是内存里这份原文;临时目录那份只是硬杀时的兜底。
let originalDevVars = null;
let patchedHash = null;

function overrideAuthUrl(publicUrl) {
  const original = readDevVars();
  if (original === null) return; // 没这个文件就别造一个,那说明配置来自别处
  const line = `BETTER_AUTH_URL=${publicUrl}`;
  const patched = /^BETTER_AUTH_URL=.*$/m.test(original)
    ? original.replace(/^BETTER_AUTH_URL=.*$/m, line)
    : `${original.replace(/\n?$/, "\n")}${line}\n`;
  if (patched === original) return; // 已经是这个地址了
  patchedHash = sha(patched);
  writeFileSync(stashPath(patchedHash), original);
  writeFileSync(DEV_VARS, patched);
  originalDevVars = original;
}

// 同样先比对再还原:运行期间你要是自己动了 .dev.vars(比如加了个 key),那份改动比我们的还原重要。
function restoreAuthUrl() {
  if (originalDevVars === null) return;
  const current = readDevVars();
  if (current !== null && sha(current) === patchedHash) {
    writeFileSync(DEV_VARS, originalDevVars);
    rmSync(stashPath(patchedHash), { force: true });
  } else {
    console.log(`\n.dev.vars 运行期间被改过 —— 没还原,免得盖掉你的改动。`);
    console.log(`原文在 ${stashPath(patchedHash)},BETTER_AUTH_URL 记得自己换回去。`);
  }
  originalDevVars = null;
}

const children = [];
let done = false;
function shutdown(code = 0) {
  if (done) return;
  done = true;
  for (const c of children) c.kill("SIGTERM");
  restoreAuthUrl(); // 先停服务再还原,免得 vite 监听到改动又热重载一次
  process.exit(code);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => shutdown(0));
process.on("exit", restoreAuthUrl); // 正常退出 / 抛异常都兜住

function vite(args, host) {
  const child = spawn("pnpm", ["exec", "vite", ...args], {
    stdio: "inherit",
    cwd: WEB_ROOT,
    env: { ...process.env, DEV_ALLOWED_HOST: host },
  });
  children.push(child);
  return child;
}

function startServer(publicUrl) {
  const host = URL.parse?.(publicUrl)?.host ?? publicUrl;
  overrideAuthUrl(publicUrl);

  console.log(`\n  ${publicUrl}  ${usePreview ? "(构建产物)" : "(dev)"}`);
  console.log(
    originalDevVars === null
      ? "  BETTER_AUTH_URL 无需改动"
      : "  BETTER_AUTH_URL 已临时指向它(rpID 跟着走),退出时还原",
  );
  if (!name) console.log("  域名是随机的 → 手机上要重新注册 passkey");
  console.log("  Ctrl+C 停止(隧道和服务一起)\n");

  if (!usePreview) {
    vite(["dev", "--port", PORT], host).on("exit", (c) => shutdown(c ?? 0));
    return;
  }
  vite(["build"], host).on("exit", (c) => {
    if (c !== 0) return shutdown(c ?? 1);
    vite(["preview", "--port", PORT], host).on("exit", (c2) => shutdown(c2 ?? 0));
  });
}

const tunnel = spawn(
  "cloudflared",
  name
    ? ["tunnel", "run", "--url", `http://localhost:${PORT}`, name]
    : ["tunnel", "--url", `http://localhost:${PORT}`, "--no-autoupdate"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
children.push(tunnel);

tunnel.on("error", (err) => {
  console.error(
    err.code === "ENOENT"
      ? "找不到 cloudflared。装一下:brew install cloudflared"
      : `启动 cloudflared 失败:${err.message}`,
  );
  shutdown(1);
});
tunnel.on("exit", (code) => {
  if (!done && code !== 0) {
    console.error(`cloudflared 退出了(code ${code})。`);
    shutdown(code ?? 1);
  }
});

if (name) {
  startServer(hostname); // 命名隧道的域名是已知的,不用等它打印
} else {
  // quick tunnel 把随机域名混在 banner 里打到 stderr,抓第一个就够。
  let started = false;
  for (const stream of [tunnel.stdout, tunnel.stderr]) {
    createInterface({ input: stream }).on("line", (line) => {
      const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !started) {
        started = true;
        startServer(match[0]);
      }
    });
  }
  setTimeout(() => {
    if (!started) {
      console.error("等了 60 秒没等到 trycloudflare 域名,单独跑一下 cloudflared 看它报什么。");
      shutdown(1);
    }
  }, 60_000).unref();
}

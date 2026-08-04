#!/usr/bin/env node
// 一条命令把「手机上测这个 app」需要的四件事串起来:开隧道 → 拿到域名 → 把 BETTER_AUTH_URL 指过去
// → 起 dev server。退出时把 .dev.vars 原样改回来。
//
// **为什么不用 @cloudflare/vite-plugin 内建的 tunnel**(它确实有,`tunnel: true` 或 dev 里按 t):
// 顺序对不上。passkey 的 rpID 是从 BETTER_AUTH_URL 派生的,所以域名必须在 dev server **启动前**就
// 知道;而插件的隧道是 dev server 起来之后才建的,随机域名那一刻才存在。所以这里自己先起
// cloudflared、拿到域名,再把 dev server 拉起来。
//
// **用命名隧道能让域名固定下来**,好处不只是省事:rpID 不变,手机上注册过的 passkey 每次都能复用,
// 不用每测一轮就重新注册。需要一个挂在 Cloudflare 上的域名,一次性配置:
//
//   cloudflared tunnel login
//   cloudflared tunnel create folio-local
//   cloudflared tunnel route dns folio-local folio-local.你的域名
//
// 然后在 `.dev.vars`(本地私有、不入库)里加两行,这个脚本会自己读:
//
//   TUNNEL_NAME=folio-local
//   TUNNEL_HOSTNAME=https://folio-local.你的域名
//
// 之后 `pnpm dev:tunnel` 就走命名隧道。没配这两行就走随机的 trycloudflare 域名 —— 能用,但每次域名
// 都变,手机上得重新注册 passkey。
//
// **注意 BETTER_AUTH_URL 仍然是临时改的**,即使域名固定也一样:平时 `pnpm dev` 访问的是
// http://localhost:3000,而 rpID 从 BETTER_AUTH_URL 派生 —— 把它写死成隧道域名,本机 localhost 上
// 的 passkey 就全部对不上了。所以只在隧道跑着的时候指过去,退出立刻改回来。

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const DEV_VARS = new URL("../.dev.vars", import.meta.url);
const PORT = process.env.PORT ?? "3000";
const KEY = "BETTER_AUTH_URL";

// 只读回 .dev.vars 原文并整行替换,别解析成键值再写回去 —— 那会丢注释、也会把别的 secret 重新格式化。
const original = readFileSync(DEV_VARS, "utf8");

// 隧道配置也从 .dev.vars 读(它本来就是「本地私有配置」那个文件),省得每次敲一长串环境变量;
// 显式给了环境变量就以环境变量为准。只取这两个键,不去碰文件里别的东西。
function fromDevVars(key) {
  return original.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim() || undefined;
}

const named = process.env.TUNNEL_NAME ?? fromDevVars("TUNNEL_NAME");
const namedHostname = process.env.TUNNEL_HOSTNAME ?? fromDevVars("TUNNEL_HOSTNAME");

if (named && !namedHostname) {
  console.error(`TUNNEL_NAME=${named} 需要同时给 TUNNEL_HOSTNAME(命名隧道对应的完整 https 地址)。`);
  process.exit(1);
}

if (!new RegExp(`^${KEY}=`, "m").test(original)) {
  console.error(`.dev.vars 里没有 ${KEY} 这一行,先照 .dev.vars.example 补上。`);
  process.exit(1);
}

let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  writeFileSync(DEV_VARS, original);
  console.log(`\n已把 .dev.vars 的 ${KEY} 改回原值。`);
}

function pointAt(url) {
  writeFileSync(DEV_VARS, original.replace(new RegExp(`^${KEY}=.*$`, "m"), `${KEY}=${url}`));
}

// 退出路径全兜住:漏一个就会留下一份指向隧道的 .dev.vars,而那会让本机 localhost 上所有 passkey
// 当场失效(rpID 不匹配),排查起来一头雾水。
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    restore();
    process.exit(0);
  });
}
process.on("exit", restore);
process.on("uncaughtException", (err) => {
  restore();
  throw err;
});

function startDev(publicUrl) {
  pointAt(publicUrl);
  console.log(`\n  隧道地址   ${publicUrl}`);
  console.log(`  ${KEY}  已临时指向它(passkey 的 rpID 从这里派生)`);
  if (!named) {
    console.log("  注意       域名是随机的 → 手机上要重新注册 passkey,旧的在这个域名下用不了");
  }
  console.log("  停止       Ctrl+C(会自动把 .dev.vars 改回去)\n");

  // 把域名透给 vite:它的 host 白名单(防 DNS rebinding)默认只认 localhost,自定义域名会被挡成
  // 「This host is not allowed」。走环境变量而不是写进 vite.config,这样私有域名不入库。
  const dev = spawn("pnpm", ["exec", "vite", "dev", "--port", PORT], {
    stdio: "inherit",
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, TUNNEL_HOSTNAME: publicUrl },
  });
  dev.on("exit", (code) => {
    restore();
    process.exit(code ?? 0);
  });
}

const args = named
  ? ["tunnel", "run", "--url", `http://localhost:${PORT}`, named]
  : ["tunnel", "--url", `http://localhost:${PORT}`, "--no-autoupdate"];

const tunnel = spawn("cloudflared", args, { stdio: ["ignore", "pipe", "pipe"] });

tunnel.on("error", (err) => {
  console.error(
    err.code === "ENOENT"
      ? "找不到 cloudflared。装一下:brew install cloudflared"
      : `启动 cloudflared 失败:${err.message}`,
  );
  restore();
  process.exit(1);
});
tunnel.on("exit", (code) => {
  if (code !== 0) {
    console.error(`cloudflared 退出了(code ${code})。`);
    restore();
    process.exit(code ?? 1);
  }
});

if (named) {
  // 命名隧道的域名是我们自己给的,不用等它打印。
  startDev(namedHostname);
} else {
  // quick tunnel 把随机域名打在 stderr 上(混在 banner 里),抓到第一个就够。
  let started = false;
  for (const stream of [tunnel.stdout, tunnel.stderr]) {
    createInterface({ input: stream }).on("line", (line) => {
      const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !started) {
        started = true;
        startDev(match[0]);
      }
    });
  }
  setTimeout(() => {
    if (!started) {
      console.error("等了 60 秒没等到 trycloudflare 域名,自己跑一下 cloudflared 看看报什么。");
      tunnel.kill();
      restore();
      process.exit(1);
    }
  }, 60_000).unref();
}

// 起 dev 之前清掉本仓遗留的 dev server(由 package.json 的 `predev` 自动调用)。
//
// 为什么需要:`vite dev --port 3000` 端口被占时会自动往上加一,不报错也不退出。于是每个没停干净的
// 旧服务器都白占几个端口(Cloudflare 插件除 vite 自身还起 workerd/inspector 监听,都从 3000 往上探),
// 攒几次之后新起的服务器落到 3020 开外,而所有指着 3000 的东西(`sync:*:local` 那两个 curl、
// 回调地址、扫码调试的隧道)全都对不上,而且不会有任何提示。
//
// 为什么不用 `pkill -f`:它不在所有环境的 PATH 里,而且按命令行匹配很容易写宽 —— 一不小心把别的
// 项目的 node 也带走。`ps` 是 POSIX 保证有的,再在 Node 里按**本仓绝对路径**筛,误伤不了别人。

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 本 app 的根(scripts/ 的上一级)。只杀命令行里含这个前缀的 vite —— 换个 checkout 都不算。
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function staleDevServers() {
  // pid + 完整命令行。空格分割:第一段是 pid,其余是命令行。
  const out = execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const spaceAt = line.indexOf(" ");
      return { pid: Number(line.slice(0, spaceAt)), command: line.slice(spaceAt + 1) };
    })
    .filter(
      ({ pid, command }) =>
        pid !== process.pid &&
        pid !== process.ppid &&
        command.includes(APP_ROOT) &&
        // vite 的 dev 服务器;`vite build` / `vite preview` 不碰。
        /\bvite(\.js)?\b.*\bdev\b/.test(command),
    );
}

const stale = staleDevServers();
if (stale.length === 0) process.exit(0);

// 先 SIGTERM 让它自己收尾(workerd 子进程、.wrangler 里的文件句柄)。
for (const { pid } of stale) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // 已经自己退了,无所谓。
  }
}
await sleep(600);

// 赖着不走的再补一刀。
const survivors = staleDevServers();
for (const { pid } of survivors) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 同上。
  }
}

// 说清杀了什么 —— 静默地干掉别人的进程不是好邻居。
console.log(`[dev] 清掉 ${stale.length} 个遗留 dev server:${stale.map((s) => s.pid).join(", ")}`);

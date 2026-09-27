// perf:cpu 的具名默认值与固定路径。命令行参数能改的都在这里有一个默认,别在别处再写一遍数字。
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** apps/web 根目录(本文件在 scripts/perf/ 下)。 */
export const WEB_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * 专用的本地持久化目录 —— **绝不是**开发库 `.wrangler/state`。`.wrangler/` 整体已在 .gitignore。
 * Miniflare 按 database_id 在它下面建 SQLite(`v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`),
 * 所以同一个 id 换一个 persist 目录就是另一份库,开发库一行都碰不到。
 */
export const PERF_STATE_DIR = join(WEB_ROOT, ".wrangler", "perf-state");

/** 构建产物:`vite build` 写出来的、`wrangler deploy` 原样发出去的那一份。 */
export const DIST_SERVER_DIR = join(WEB_ROOT, "dist", "server");

// 端口刻意避开 dev server 的 3000 与 wrangler 默认的 8787 / 9229,好让 perf 与 `pnpm dev` 同时开着。
export const DEFAULT_PORT = 3300;
export const DEFAULT_INSPECTOR_PORT = 9330;
export const HOST = "127.0.0.1";

/** 每个端点测几发(顺序发,一次一发)。 */
export const DEFAULT_REPS = 30;
/** 正式采样前的预热发数 —— 让首调编译不混进稳态数字(冷启动另有 `--cold`)。 */
export const DEFAULT_WARMUP = 5;
/** V8 采样间隔(微秒)。 */
export const DEFAULT_SAMPLING_US = 100;
/** Cloudflare Workers 免费档:每请求 10ms CPU。 */
export const DEFAULT_BUDGET_MS = 10;

/** 等 wrangler dev 起来的上限与轮询间隔。起的时候会去拉 `Request.cf`,断网时要等它失败。 */
export const READY_TIMEOUT_MS = 90_000;
export const READY_POLL_MS = 500;
/** 停 worker 时 SIGTERM 之后等多久再 SIGKILL。 */
export const STOP_GRACE_MS = 5_000;

// ---- 数据集(见 dataset.mjs)。大小可由参数改,这里是默认。 ----
export const DEFAULT_ACCOUNTS = 8;
export const DEFAULT_TOKENS = 60;
export const DEFAULT_DAYS = 30;
/** 有日价的代币数与天数(长区间曲线要用)。 */
export const DAILY_PRICE_TOKENS = 20;
export const DAILY_PRICE_DAYS = 365;

/** 压测用户。只存在于上面那个专用库里;密码不是秘密,它守的是一个本地、随时可删的库。 */
export const PERF_USER = {
  email: "perf@folio.test",
  password: "perf-password-1234",
  name: "Perf",
};

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

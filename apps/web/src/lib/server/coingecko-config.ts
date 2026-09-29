// CoinGecko client 的公共配置,从一张「变量名 → 值」表里读。**纯函数、不碰 env** —— 读哪张表是
// 调用方的事:Worker 里是 `cloudflare:workers` 的 env(`./oracle.ts`),GitHub Actions 里刷全局映射表的
// Node 脚本是 `process.env`(`scripts/ref-index/`,FOL-85)。两边同一套规矩,所以只写这一份。
//
// `COINGECKO_API_BASE`(FOL-84):base URL 覆盖,**生产不设** → 按有没有 key 选官方免费 / pro 基址。
// 设了的只有本地 perf 压测(`scripts/perf/fake-upstream.mjs` 指到本机假上游)。它不在 wrangler 生成的
// `Env` 类型里(那份按 .dev.vars 现场生成),所以按名字读,与 sync 的 provider 凭据注入同款。
// 空串当没设:`.dev.vars` 里留一行 `COINGECKO_API_BASE=` 不该把请求打到空基址上。
export const coinGeckoConfigOf = (vars: Record<string, string | undefined>) => ({
  apiKey: vars.COINGECKO_API_KEY || undefined,
  baseUrl: vars.COINGECKO_API_BASE?.trim() || undefined,
});

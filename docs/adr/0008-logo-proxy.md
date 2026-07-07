# Logo 代理端点 —— 内部 id 代理 + Workers Cache + 客户端 fallback

Status: accepted (planned)

新增公开端点 `GET /api/logo/:kind/:id`(`kind` = `token` | `platform`)代理 token / 平台 logo:key 用**内部稳定 id**(token→CoinGecko id,platform→platform key),服务端按 id 从 token/platform store **resolve → 上游图 URL** 再取,**客户端(dashboard / 持仓渲染)只见 folio 自己的 URL、CoinGecko 不露面**(token-picker 搜索结果 logo 暂仍直载 —— 见 Consequences 末条)。纯 **on-demand 代理**,前置 **Cloudflare Workers Cache**(`wrangler` `"cache":{"enabled":true}`)缓存响应;不引 R2。服务端在 enrich/读模型层**有条件重写** `logo`→代理 URL(仅有上游图时;否则 `undefined` → 客户端 `AvatarFallback` 首字母),`TokenAvatar` 不动。缓存命中即不进 Worker。

## Considered Options

1. **现状:客户端直载上游 URL**(`<img src={coingecko-url}>`)—— 把"用户持有哪些币/用哪些链所"经 IP+referer **泄露给 CoinGecko 图片 CDN**;上游 URL 变/404 无兜底。
2. **URL 透传代理**(`/api/logo?u=<编码上游 url>`)—— 隐藏用户 IP,但客户端 HTML 仍引用 CoinGecko URL、URL 不稳定 → **隐私半吞、非自控**。
3. **内部 id 代理 + Workers Cache(选中)** —— 客户端零引用 CoinGecko、URL 永久自控、上游可换;边缘缓存高命中、命中零成本(不进 Worker)。多一次 miss 时的 store resolve。
4. **R2 落字节** —— 永久解耦 + 扛 eviction,但新 binding/写路径/陈旧失效,对自托管、KB 级图、高命中场景过度工程 → 留后续可选。

## Consequences

- **隐私(主要驱动)**:客户端不再向 CoinGecko CDN 暴露持仓;命中不进 Worker;miss 时 Worker 取上游 —— CoinGecko 只见 folio 的 IP、不见终端用户、串不出 per-user 持仓。
- **公开端点**:必须 unauth(Workers Cache 对带鉴权请求 bypass;logo 是公共数据),落 `apps/web/src/routes/api/logo/`(`createFileRoute(...).server.handlers`)。
- **无 R2**:纯代理;R2 作后续升级(若上游频繁 404 / 命中率不佳)。
- **缓存**:命中 `public, max-age=1d, stale-while-revalidate=30d`;上游 404 → 端点 404 + 短负缓存;上游 5xx/超时 → 502 `no-store`(可重试);挂 `Cache-Tag: logo:<kind>:<id>`,首版不接 purge 触发器(靠 SWR 窗自然收敛)。
- **客户端不变**:`TokenAvatar` 仍收一个 `logo` URL;重写在产 `logo` 的读模型单点,天然覆盖各渲染站。token-picker 搜索结果 logo(不走读模型)是否代理为建时小尾巴。
- **计费小注**:开启 Workers Cache 后静态资源/worker-to-worker 请求从免费转按标准请求计费(自托管量级可忽略)。
- **非领域概念** → CONTEXT.md 不加词条;这是基建端点。

# Logo 代理端点 —— 内部 id 代理 + Workers Cache + 客户端 fallback

Status: accepted (planned)

新增公开端点 `GET /api/logo/:kind/:id`(`kind` = `token` | `platform`)代理 token / 平台 logo:key 用**内部代币行 id**(`tokens.id` UUID 主键,source 无关、跨 re-sync 稳定;platform→platform key),服务端按 id 从 store **读整行 → 上游图 URL**(`logo ?? providerLogo`)再取,**客户端只见 folio 自己的 URL、任何第三方图片 CDN(CoinGecko / provider)在前端都不露面**。纯 **on-demand 代理**,前置 **Cloudflare Workers Cache**(`wrangler` `"cache":{"enabled":true}`)缓存响应;不引 R2。服务端在 enrich/读模型层**有条件重写** `logo`→代理 URL(有内部 id 且有上游图时;否则 `undefined` → 客户端 `AvatarFallback` 首字母),`TokenAvatar` 不动。缓存命中即不进 Worker。

> **为何用内部行 id 而非 CoinGecko id**:CGK id 只覆盖 CGK 收录币,孤儿(provider-only,`ref=null`)没有;而 `tokens.id` 每行都有、source 无关,一个 key 同时寻址 CGK canonical 图与孤儿 `providerLogo`,让代理**覆盖全部来源**(否则 provider CDN 仍泄露持仓)。id 稳定性:每条写路径都复用已有行 id(`existing?.id ?? randomUUID()`)、`onConflictDoUpdate` 不改主键、行不随 TTL 删 → 可安全作缓存 URL key。**例外**:孤儿升级合并(`linkTokenKeyToCgk`,CGK 新收录该币)会删孤儿行、id 换成 cgk 行 id;已渲染页面里旧 `/api/logo/token/<orphanId>` 会短暂 404(自愈:下次渲染用新 id;负缓存 ≤1h)。可接受。`getById` 因此按主键服务、不门控 info TTL(行在即给),与渲染路径 `getByTokenKey` 一致,避免长尾币 info 过期(30d)后图裂。

## Considered Options

1. **现状:客户端直载上游 URL**(`<img src={coingecko-url}>`)—— 把"用户持有哪些币/用哪些链所"经 IP+referer **泄露给 CoinGecko 图片 CDN**;上游 URL 变/404 无兜底。
2. **URL 透传代理**(`/api/logo?u=<编码上游 url>`)—— 隐藏用户 IP,但客户端 HTML 仍引用 CoinGecko URL、URL 不稳定 → **隐私半吞、非自控**。
3. **内部行 id 代理 + Workers Cache(选中)** —— 客户端零引用任何第三方图片 CDN、URL 永久自控、上游可换;一个 id 覆盖 CGK 图与孤儿 providerLogo;边缘缓存高命中、命中零成本(不进 Worker)。多一次 miss 时的 store 读。
4. **R2 落字节** —— 永久解耦 + 扛 eviction,但新 binding/写路径/陈旧失效,对自托管、KB 级图、高命中场景过度工程 → 留后续可选。

## Consequences

- **隐私(主要驱动)**:客户端不再向任何第三方图片 CDN(CoinGecko / provider)暴露持仓;命中不进 Worker;miss 时 Worker 取上游 —— 上游只见 folio 的 IP、不见终端用户、串不出 per-user 持仓。
- **公开端点**:必须 unauth(Workers Cache 对带鉴权请求 bypass;logo 是公共数据),落 `apps/web/src/routes/api/logo/`(`createFileRoute(...).server.handlers`)。
- **无 R2**:纯代理;R2 作后续升级(若上游频繁 404 / 命中率不佳)。
- **缓存**:命中 `public, max-age=1d, stale-while-revalidate=30d`;上游 404 → 端点 404 + 短负缓存;上游 5xx/超时 → 502 `no-store`(可重试);挂 `Cache-Tag: logo:<kind>:<id>`,首版不接 purge 触发器(靠 SWR 窗自然收敛)。
- **契约**:`EnrichedAsset` / `TokenInfo` 带内部 `id`;`TokenStore.getById(id)` / `Tokens.logoUrlById(id)` 按行 id 读上游图 URL(cache-only,不回源)。
- **客户端不变**:`TokenAvatar` 仍收一个 `logo` URL;重写落在产 `logo` 的各 app 层单点 —— 读模型(dashboard / 持仓,含孤儿 providerLogo)+ 选币默认下拉 `topTokens`(读 store 带 id,可代理)。
- **尾巴:`searchTokens` 结果不代理**。search 是对 CGK 的 live pass-through、结果不写 store、无内部 id;而 `/api/logo` 按内部 id 读 store(`getById`,不回源),未持有的搜索命中查不到 → 会 404 图裂。故搜索结果直返上游 URL(隐私半吞,仅在用户主动搜索时短暂暴露)。要收口须让 search 结果落 store,或给端点加 live-resolve 回源(重新引入公开端点放大面)—— 留后续。
- **安全**:代理响应只透传栅格图 content-type(`png/jpeg/gif/webp/avif/ico`),svg/html 等降级 `application/octet-stream` + `X-Content-Type-Options: nosniff`,挡"上游被投毒 → 本域内联执行"。
- **计费小注**:开启 Workers Cache 后静态资源/worker-to-worker 请求从免费转按标准请求计费(自托管量级可忽略)。
- **非领域概念** → CONTEXT.md 不加词条;这是基建端点。

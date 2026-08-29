// Logo 代理 URL 构造(客户端安全:纯字符串,无 @scure/无 server-only import)。
// 读模型在产 `logo` 时用它把上游 URL 改写成 folio 自己的 `/api/logo/...`,使客户端零引用任何
// 第三方图片 CDN(隐私:不向 CGK / provider CDN 泄露持仓)。见 ADR 0008。

// 代理所需的最小形状(FOL-48):**不带上游 URL** —— 有内部 id 就能拼 `/api/logo/token/{id}`,
// 上游 URL 是纯冗余(实测让富化字典白白膨胀几 KB)。只留「有没有图」的布尔。**内嵌 data: 图也走
// 代理**(FOL-48:`/api/logo` 端点已能解码 data-URI 返回,见 `logos/serve.ts`)—— 于是 logo 100%
// 由 token id 派生,payload 不带任何 URL。
interface LogoSource {
  id?: string; // 内部代币行 id(在 store 才有;logo 代理的稳定 key)
  hasLogo?: boolean; // 上游有任一图(http 或 data: 内嵌)—— 都能由 id 经代理拿
}

// 有内部 id + 有图 → 代理为 `/api/logo/token/<id>`(客户端零第三方 CDN 引用;http 与 data: 内嵌图都
// 由代理端点返回);都没有 → undefined(客户端 AvatarFallback 首字母,不发请求)。
export function tokenLogoUrl(e: LogoSource): string | undefined {
  if (e.id && e.hasLogo) return `/api/logo/token/${encodeURIComponent(e.id)}`;
  return undefined;
}

// 从上游 logo 字段(canonical / provider,可能是 http URL 或 data: 内嵌图)派生代理所需的最小信息:
// 有没有图。富化下发到浏览器 / 喂 buildOverview 前一律经此收窄,把上游 URL 挡在 payload 之外。
export function toLogoSource(e: { id?: string; logo?: string; providerLogo?: string }): {
  id?: string;
  hasLogo: boolean;
} {
  return { id: e.id, hasLogo: !!(e.logo || e.providerLogo) };
}

// DeFi 协议 logo:协议名(可能含空格,如 "Opyn V2")即稳定 key。有上游图 → 代理为
// `/api/logo/defi/<protocol>`(服务端从快照 meta 解析出真 URL,客户端零第三方 CDN);无图 →
// undefined(客户端 AvatarFallback 首字母,不发请求)。见 ADR 0008 / #126。
export function defiLogoUrl(protocol: string, logo?: string): string | undefined {
  if (!logo) return undefined;
  return `/api/logo/defi/${encodeURIComponent(protocol)}`;
}

// 平台 logo:平台 key 本身即稳定 id(如 bitcoin / evm:1 / exchange:binance,可能含 `:`)。
// 有上游图 → 代理为 `/api/logo/platform/<key>`;无图 → undefined(客户端 fallback,不发请求)。见 #20。
export function platformLogoUrl(key: string, logo?: string): string | undefined {
  if (!logo) return undefined;
  // 内置静态图(如 manual 的 NotebookPen data-URI)直挂:无隐私顾虑,且 /api/logo 代理只 fetch http 栅格图。
  if (logo.startsWith("data:")) return logo;
  return `/api/logo/platform/${encodeURIComponent(key)}`;
}

// connector 展示名的**兜底**(#467):目录还没到位时先显什么。
//
// 权威名住 connector manifest(`manifest.label`),经 server fn 的目录下发。它是部署内静态的、
// 缓存一次就不再变,所以「拿不到」只发生在**每次冷加载的第一帧** —— 而那一帧原来直接把内部 id
// 印在界面上(`hyperliquid` / `okx`),十行一起闪一下,像数据坏了。
//
// 现在那一帧至少是个像名字的名字。**根治在预取**(渲染徽标的路由把目录一起预取,见 routes 里的
// loader),这里只是最后一道 —— 新页面忘了预取、或者目录那条请求挂了,也不该露出内部 id。
//
// **两个不是「首字母大写」的**:`evm` → EVM、`okx` → OKX。列在这里是有意的重复,判据是
// 「这一帧只由这一处决定,而正确答案两秒后就会覆盖它」—— 所以宁可这一帧也是对的。
// manifest 仍是唯一权威:改名只会让这张表在那一帧略旧,不会让界面长期显错。
const ACRONYMS: Record<string, string> = { evm: "EVM", okx: "OKX" };

export function connectorLabelFallback(connectorId: string): string {
  if (!connectorId) return connectorId;
  return ACRONYMS[connectorId] ?? connectorId.charAt(0).toUpperCase() + connectorId.slice(1);
}

// Binance REST 常量(不硬编码散落,见原则 #8)。
//
// **只有请求层要的那些在这里。** 老 provider 包的 constants.ts 里还有 `QUOTE_ASSET` / `STABLECOINS`
// / `QUOTE_SUFFIXES` / `MARGIN_ASSET` —— 那几个是**估值和符号解析**用的,属于适配层,不进 client
// (ADR 0036)。

// —— 现货 / 主 host ——
export const BINANCE_API_BASE = "https://api.binance.com";
export const ACCOUNT_PATH = "/api/v3/account"; // SIGNED,USER_DATA(只读 key 即可)
export const TICKER_PRICE_PATH = "/api/v3/ticker/price"; // 公开免签,全市场价
export const API_KEY_HEADER = "X-MBX-APIKEY";
export const RECV_WINDOW = 5000; // 请求有效窗口(ms)

// —— 速率闸(**只给公开端点,不给签名端点**)——
// 这个区分是要点:binance 的额度按 **IP** 算,不按 key 算 —— 而 `TICKER_PRICE_PATH` 是公开免签的,
// 于是所有账户、**所有用户**共花同一份出口 IP 的额度。`ACCOUNT_PATH` 那一发是签名的,
// 花的仍是同一份 IP 额度,但一个账户只发一次、且不并发,装闸拦不到任何东西(桶永远是满的)。
//
// 文档:Spot REST 的 REQUEST_WEIGHT 是 **6000 权重/分钟/IP**;不带 symbol 的
// `/api/v3/ticker/price` 是全市场,权重上限 200 → 约 30 次/分钟就吃满一个 IP 的额度。
// 出处:https://developers.binance.com/docs/binance-spot-api-docs/rest-api/limits
//       (权重上限 6000/min;ticker 每 symbol 权重 4,>50 个 symbol 时封顶 200)
//
// 速率 24/分钟(标称 30 的 80%),容量 6 —— **容量刻意等于 SYNC_CONCURRENCY**:常见情形
// (6 个账户各一发)一口气走完、不给同步添延迟,只有超出这个突发的量才被摊开。
// 429 之后还会 418(自动封 IP,2 分钟到 3 天),所以这里宁可保守。
export const TICKER_RATE_LIMIT_PER_SEC = 24 / 60;
export const TICKER_RATE_LIMIT_BURST = 6;
// 公开端点闸的 key:**provider 级、按出口 IP**,不是每账户 —— 见上。
export const PUBLIC_LIMIT_KEY = "binance:public";
// 429 之外还要认 418(收到 429 继续打换来的封 IP,同类处理)。
export const RATE_LIMITED_STATUSES = [429, 418] as const;

// —— U 本位合约(USDⓈ-M Futures)——
// 合约在**独立 host**(fapi.binance.com),需另一个签名 client。V2 account 一发即拿账户权益 + 各持仓。
export const BINANCE_FUTURES_API_BASE = "https://fapi.binance.com";
export const USDM_ACCOUNT_PATH = "/fapi/v2/account"; // SIGNED,账户权益 + 持仓一发全给

// —— 币本位合约(COIN-M Futures)——
// 又一个独立 host(dapi.binance.com)。保证金是**币**而非 USDT,折算归适配层。
export const BINANCE_DELIVERY_API_BASE = "https://dapi.binance.com";
export const COINM_ACCOUNT_PATH = "/dapi/v1/account"; // SIGNED,per-asset 权益 + 持仓

// —— 资金账户(Funding)——
// 在主 api host,但是 **POST**(SIGNED)。返回币种 + 数量,无 USD。
export const FUNDING_ASSET_PATH = "/sapi/v1/asset/get-funding-asset";

// —— 理财(Simple Earn)——
// 活期 + 定期两个 GET(SIGNED,主 api host)。
export const EARN_FLEXIBLE_PATH = "/sapi/v1/simple-earn/flexible/position";
export const EARN_LOCKED_PATH = "/sapi/v1/simple-earn/locked/position";
// position 端点分页:size 默认 10、最大 100。持仓多于 10 个(小额自动申购很常见)时首页截断 →
// 按 size=100 循环翻页取全。EARN_MAX_PAGES 是死循环护栏(100×50=5000 个持仓,远超任何真实账户)。
export const EARN_PAGE_SIZE = 100;
export const EARN_MAX_PAGES = 50;

// binance 用 HTTP 400 表达「这份签名请求被拒」—— 见 errors.ts 为什么它归凭据问题而非传输故障。
export const SIGNED_REQUEST_REJECTED_STATUS = 400;

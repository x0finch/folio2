// Binance Spot API 常量(不硬编码散落,见原则 #8)。
export const BINANCE_API_BASE = "https://api.binance.com";
export const ACCOUNT_PATH = "/api/v3/account"; // SIGNED,USER_DATA(只读 key 即可)
export const TICKER_PRICE_PATH = "/api/v3/ticker/price"; // 公开免签,全市场价
export const API_KEY_HEADER = "X-MBX-APIKEY";
export const RECV_WINDOW = 5000; // 请求有效窗口(ms)

// 计价用的报价币:asset 在 USD 估值 = amount × price(`${asset}USDT`)。
export const QUOTE_ASSET = "USDT";
// 视为 ≈1 USD 的稳定币(无 `${asset}USDT` 自对)。
export const STABLECOINS: ReadonlySet<string> = new Set([
  "USDT",
  "USDC",
  "BUSD",
  "FDUSD",
  "TUSD",
  "DAI",
]);

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

// —— U 本位合约(USDⓈ-M Futures)——
// 合约在**独立 host**(fapi.binance.com),需另一个签名 client(见 index.ts)。V2 account 一发即拿
// 账户权益 + 各持仓(V2 的 positions 保留 leverage/entryPrice/notional;强平价不在此响应 → 留 null)。
export const BINANCE_FUTURES_API_BASE = "https://fapi.binance.com";
export const USDM_ACCOUNT_PATH = "/fapi/v2/account"; // SIGNED,账户权益 + 持仓一发全给
// U 本位保证金计价资产(账户权益以 USDT 计,天然 USD)。
export const MARGIN_ASSET = "USDT";
// 合约 symbol 去尾得标的币名(BTCUSDT → BTC)。按已知计价后缀由长到短剥(先 USDC 再 USDT,避免误剥)。
export const QUOTE_SUFFIXES: readonly string[] = ["USDT", "USDC", "BUSD", "FDUSD", "TUSD"];

// —— 币本位合约(COIN-M Futures)——
// 又一个独立 host(dapi.binance.com)。与 U 本位的关键差异:保证金是**币**(BTC/ETH…)、无单一 USD
// 总权益 —— 各币 marginBalance / notional / 盈亏都按行情折 USD 再聚合(见 parseCoinmFuturesAccount)。
export const BINANCE_DELIVERY_API_BASE = "https://dapi.binance.com";
export const COINM_ACCOUNT_PATH = "/dapi/v1/account"; // SIGNED,per-asset 权益 + 持仓

// —— 资金账户(Funding)——
// 在主 api host,但是 **POST**(SIGNED)。返回币种 + 数量(free/locked/freeze),无 USD → 同现货用 ticker 估值。
export const FUNDING_ASSET_PATH = "/sapi/v1/asset/get-funding-asset";

// —— 理财(Simple Earn)——
// 活期 + 定期两个 GET(SIGNED,主 api host)。返回币种 + 数量 + APY(活期还带浮动利率、定期带到期日),
// 无 USD → 同现货用 ticker 估值,当 spot;APY / 锁定期挂 balance 级 note(info 语气)。
export const EARN_FLEXIBLE_PATH = "/sapi/v1/simple-earn/flexible/position";
export const EARN_LOCKED_PATH = "/sapi/v1/simple-earn/locked/position";

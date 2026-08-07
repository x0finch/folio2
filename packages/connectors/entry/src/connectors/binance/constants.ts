// binance **适配层**的常量(原则 #8)。
//
// **只有解析要用的东西。** 端点路径、base URL、签名窗口、限频参数全归 `@folio/binance-client` ——
// 那一半是「怎么跟上游说话」,这一半是「怎么把上游的话翻成 folio 的 Balance」(ADR 0036)。
// 拆包时这个文件从 66 行掉到 20 出头,少掉的正是搬去 client 的那些。

// provider 的 id,同时是 `tokenRef.issued(...)` 的发行方标识 —— 改它等于改所有 binance 代币的身份。
export const PROVIDER_ID = "binance";

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

// U 本位保证金计价资产(账户权益以 USDT 计,天然 USD)。
export const MARGIN_ASSET = "USDT";

// 合约 symbol 去尾得标的币名(BTCUSDT → BTC)。按已知计价后缀**由长到短**剥
//(先 USDC 再 USDT,避免误剥)。
export const QUOTE_SUFFIXES: readonly string[] = ["USDT", "USDC", "BUSD", "FDUSD", "TUSD"];

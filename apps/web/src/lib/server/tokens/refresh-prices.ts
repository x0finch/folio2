import { FIAT_NAMER } from "@folio/oracle-basic";
import { getLogger } from "@logtape/logtape";
import { NAMER, runRequest } from "../oracle";
import { priceTickets } from "./pricing";

const tokenLog = getLogger(["folio", "web", "tokens"]);

// 选币下拉的 SWR 刷价:一批票 → 现价 + 涨跌(#226)。展示时对价过期/缺失的可见行批量走一次
// `/simple/price` 回填。**POST 不是 GET**:一批票可到几十条、每条几十字符,塞进 GET 的 query
// 会把 URL 撑爆(正是 #245 那类 414);而且这是用户触发的实时刷,不该走边缘缓存。
// **不建行、不写缓存**(pricesByRefs 语义)—— 用户还在划,行只在提交时由 mint 建。
export async function handleRefreshTokenPrices({
  data,
  context,
}: {
  data: { tickets: string[] };
  context: { userId: string };
}) {
  // 票携带当前上游(加密币)或 `fiat`(法币)命名者,两者都放行(同 getTokenPrice / mintHolding)——
  // 只收 NAMER 的话「已有代币」组里的法币持仓会被丢掉、价格列恒显 "—"(法币无代币市价,得走 FX)。
  // 分流(法币走 FX / 其余走代币源)在纯函数 priceTickets 里,两个选币端点共用、可单测。
  const out = await runRequest(
    context.userId,
    // `warmFiat` 开着:冷则一把拉全支持币种;通常已暖 → no-op。
    priceTickets(data.tickets, { namers: [NAMER, FIAT_NAMER], warmFiat: true }),
  );
  tokenLog.debug("refreshTokenPrices: ok", { asked: data.tickets.length, got: out.length });
  return out;
}

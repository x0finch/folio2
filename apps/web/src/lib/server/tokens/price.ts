import { FIAT_NAMER } from "@folio/oracle-basic";
import { getLogger } from "@logtape/logtape";
import { NAMER, runRequest } from "../oracle";
import { priceTickets } from "./pricing";

const tokenLog = getLogger(["folio", "web", "tokens"]);

// 选中之后取现价预填单价(用户可改)。**票解不开就当没选** —— 它是从网络上来的。
// 票可携带当前上游(加密币)或 `fiat`(法币)命名者,两者都放行(见 mintHolding 同款集合)。
export async function handleGetTokenPrice({
  data,
  context,
}: {
  data: { ticket: string };
  context: { userId: string };
}) {
  // 与批量刷价同一段分流(priceTickets):法币走 FX、其余走代币源。这里一次只一张票,取首条 → 无价回 null,
  // 让用户自己填(别过度设计)。**不 warm** —— 预填这一下靠 loader / listFiatOptions 已暖的缓存,别再拉一趟。
  const [priced] = await runRequest(
    context.userId,
    priceTickets([data.ticket], { namers: [NAMER, FIAT_NAMER] }),
  );
  tokenLog.debug("tokenPrice: ok", { found: priced != null });
  return priced
    ? { unitPrice: priced.unitPrice, change24h: priced.change24h, asOf: priced.asOf }
    : null;
}

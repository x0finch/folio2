import { defineConnector, Spot } from "@folio/connectors-basic";
import { manualAccountCreds, manualProvider } from "@folio/connectors-provider-manual";

// manual connector manifest —— 组装契约(基座)+ provider(manual)。手动资产:无外部 API,
// 一个账户 = 一个手记持仓,全 public account.creds(symbol/amount/unitPrice + 可选 identifier)。
// manifest 组装归 entry;account.creds 声明随 provider(其天然消费者)落 provider 包,此处引入组合。
export const manual = defineConnector({
  id: "manual",
  label: "Manual",
  logo: "", // manual 无 logo,UI 走内置 WalletIcon
  account: { creds: manualAccountCreds },
  balance: { schema: Spot, providers: [manualProvider] }, // 单 kind:spot
  // 无权威价:只录数量 + 初始单价,恒按市场源价盯市重估(见 app revalue)。
  valuation: "mark-to-market",
});

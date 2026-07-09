import { defineConnector, Spot } from "@folio/connectors-basic";
import { customProvider, manualAccountCreds } from "@folio/connectors-provider-custom";

// manual connector manifest —— 组装契约(基座)+ provider(custom)。手动资产:无外部 API,
// 一个账户 = 一个手记持仓,全 public account.creds(symbol/amount/unitPrice + 可选 identifier/fixed)。
// manifest 组装归 entry;account.creds 声明随 provider(其天然消费者)落 provider 包,此处引入组合。
export const manual = defineConnector({
  id: "manual",
  label: "Manual",
  logo: "", // manual 无 logo,UI 走内置 WalletIcon
  account: { creds: manualAccountCreds },
  balance: { schema: Spot, providers: [customProvider] }, // 单 kind:spot
});

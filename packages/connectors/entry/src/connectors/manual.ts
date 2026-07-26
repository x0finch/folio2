import { type CredField, defineConnector, Spot } from "@folio/connectors-basic";
import { z } from "zod";

// manual 无外部品牌图 → 内置 NotebookPen 字形(lucide v0.545)作 logo:「手动录入」语义,且不与
// 账户钱包标记(NameLine)撞。单色描边内联 SVG data-URI —— 落在恒亮 bg-logo-bg 上,故描边用中性深色
// (这是 logo 图像素材,非组件样式,与各连接器品牌图同类,不受「只用 token」约束)。经 platformLogoUrl
// 识别 data: 前缀直挂、不进 /api/logo 代理(代理只为外部 fetch 的隐私;内置静态图无隐私且代理拉不了 data:)。
// viewBox 四周留白(-6..30):24×24 字形缩到画布 ~67%,圆形头像裁切时含描边也不切角。
// 多行只为可读;编码前 collapse 空白成单空格 → data-URI 无 %0A/缩进噪声(SVG 忽略标签间空白)。
const NOTEBOOK_PEN_SVG = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="-6 -6 36 36"
       fill="none" stroke="#52525b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/>
    <path d="M2 6h4"/>
    <path d="M2 10h4"/>
    <path d="M2 14h4"/>
    <path d="M2 18h4"/>
    <path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/>
  </svg>`;
const MANUAL_LOGO = `data:image/svg+xml,${encodeURIComponent(NOTEBOOK_PEN_SVG.replace(/\s+/g, " ").trim())}`;

// 加账户表单首个持仓的入参形状。**只在创建那一刻用** —— #203 之后它不再落库:
// 四个值分别去了 `tokens.symbol` / `tokens.self_price` / `token_refs`(选的币)/ `manual_activity`(数量),
// app 侧 `createManualAccount` 收到后就把它们写进真表。
//
// 仍然声明在 `account.creds` 里,是因为账户创建那条通用路径(`validateAccountCreds` → 表单字段渲染)
// 就是按它驱动的,manual 不该为此另开一条并行的表单机制。存库为 JSON 字符串,故 validator 先 parse。
const manualFirstHolding = z.object({
  symbol: z.string().trim().min(1),
  unitPrice: z.coerce.number(),
  identifier: z.string().trim().min(1).optional(),
  amount: z.coerce.number(),
});

const manualAccountCreds = [
  {
    key: "tokens",
    type: "public",
    label: "Tokens",
    validator: z.preprocess((v) => {
      if (typeof v !== "string") return v;
      try {
        return JSON.parse(v);
      } catch {
        return v; // → 交给 z.array 判负,报成 tokens 的校验错而非裸 throw
      }
    }, z.array(manualFirstHolding)),
  },
] as const satisfies readonly CredField[];

// manual connector manifest —— 手动资产:无外部 API。
//
// **没有 provider**(#203):手记的持仓不再经「app 物化进 creds JSON → provider 读回来」这一圈,
// 而是由 app 直接从 `tokens` + `manual_activity` 现算(ADR 0018:manual 不写快照,「此刻」是合成的)。
// 那个 provider 删掉之后 `providers` 就空了 —— manual 本来也不参与同步(见 app 的 isSyncableAccount),
// 从没有人调它的 fetchBalances。connector 仍在:图标、账户表单、盯市估值声明都由它提供。
export const manual = defineConnector({
  id: "manual",
  label: "Manual",
  logo: MANUAL_LOGO, // 内置 NotebookPen 字形(见上);data: 直挂不代理
  account: { creds: manualAccountCreds },
  balance: { schema: Spot, providers: [] }, // 单 kind:spot;无 provider(见上)
  // 无权威价:只录数量 + 初始单价,恒按市场源价盯市重估(见 app revalue)。
  valuation: "mark-to-market",
});

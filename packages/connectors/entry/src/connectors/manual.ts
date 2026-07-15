import { defineConnector, Spot } from "@folio/connectors-basic";
import { manualAccountCreds, manualProvider } from "@folio/connectors-provider-manual";

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

// manual connector manifest —— 组装契约(基座)+ provider(manual)。手动资产:无外部 API,
// 一个账户 = 一个手记持仓,全 public account.creds(symbol/amount/unitPrice + 可选 identifier)。
// manifest 组装归 entry;account.creds 声明随 provider(其天然消费者)落 provider 包,此处引入组合。
export const manual = defineConnector({
  id: "manual",
  label: "Manual",
  logo: MANUAL_LOGO, // 内置 NotebookPen 字形(见上);data: 直挂不代理
  account: { creds: manualAccountCreds },
  balance: { schema: Spot, providers: [manualProvider] }, // 单 kind:spot
  // 无权威价:只录数量 + 初始单价,恒按市场源价盯市重估(见 app revalue)。
  valuation: "mark-to-market",
});

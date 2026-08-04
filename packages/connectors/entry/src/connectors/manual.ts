import { type CredField, defineConnector, Spot } from "@folio/connectors-basic";
import { z } from "zod";

// manual 无外部品牌图 → 内置羽毛笔字形作 logo:「手动录入」语义,且不与账户标记(`@`)撞。
// 内联 SVG data-URI,经 platformLogoUrl 识别 data: 前缀直挂、不进 /api/logo 代理(代理只为外部 fetch
// 的隐私;内置静态图无隐私且代理拉不了 data:)。
//
// viewBox 不是字形自带的 `0 0 256 256` —— 那份画布里字形既不居中也贴边(实测 getBBox:x 32→240、
// y 16→232),圆形头像会切到羽尖。改为**绕字形自身包围盒**取景:中心 (136, 124),边长 324 = 216 / 0.667,
// 沿用前一版 logo 的留白比例(字形占画布 ~67%,四周各留 ~54)。半对角 150 < 内切圆半径 162 → 圆裁不着。
//
// fill 写死 #222222,**不用 currentColor**:data-URI 图没有可继承的上下文,currentColor 只能落到 UA
// 的初始 color —— Chrome 给黑色(看着没问题),但 forced-colors / 高对比度下会翻成浅色,叠在恒亮的
// bg-logo-bg 上就是一个空白圆。写死颜色即与 UA 无关(这是 logo 图像素材,与各连接器品牌图同类,
// 不受「只用 token」约束;改 CSS 对它无效)。
const FEATHER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="-26 -38 324 324" fill="#222222"><path d="m211.84 134.81l-59.79 60.47a15.75 15.75 0 0 1-11.2 4.68H75.32l-29.66 29.7a8 8 0 0 1-11.32-11.32l22.59-22.58L124.7 128H209a4 4 0 0 1 2.84 6.81m4.86-104.24a64 64 0 0 0-85.9 4.14l-9.6 9.48A4 4 0 0 0 120 47v63l55-55a8 8 0 0 1 11.31 11.31L140.71 112h88.38a4 4 0 0 0 3.56-2.16a64.08 64.08 0 0 0-15.95-79.27M62.83 167.23L104 126.06v-55.3a4 4 0 0 0-6.81-2.84L60.69 104A15.9 15.9 0 0 0 56 115.31v49.09a4 4 0 0 0 6.83 2.83"/></svg>
`;

const MANUAL_LOGO = `data:image/svg+xml,${encodeURIComponent(FEATHER_SVG.replace(/\s+/g, " ").trim())}`;

// 加账户表单首个持仓的入参形状。**只在创建那一刻用** —— #203 之后它不再落库:
// 四个值分别去了 `tokens.symbol` / `tokens.self_price` / `token_refs`(选的币)/ `manual_activity`(数量),
// app 侧 `createManualAccount` 收到后就把它们写进真表。
//
// 仍然声明在 `account.creds` 里,是因为账户创建那条通用路径(`validateAccountCreds` → 表单字段渲染)
// 就是按它驱动的,manual 不该为此另开一条并行的表单机制。存库为 JSON 字符串,故 validator 先 parse。
// `ticket` = 选币下拉发的那串不透明票(base64url 编过的 tokenRef,#202b)。这一层只当它是字符串:
// 解票是 app 在写路径边界上做的事,连接器不认识代币命名法。没选币就没有这个键。
const manualFirstHolding = z.object({
  symbol: z.string().trim().min(1),
  unitPrice: z.coerce.number(),
  ticket: z.string().trim().min(1).optional(),
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

// @folio/detail-block —— 账户级 DetailSection 渲染器(DetailBlock 重设计)。
// <BalanceDetail sections={detail} formatNumber={…}/> 用 beUI BouncyAccordion 渲染:每 section 一个
// 手风琴 item,icon 名 → lucide,content string/rows,行 href 包外链。数字 locale 格式化由 app 注入
// formatNumber(通用包不直接依赖 use-intl / @folio/fx)。
export { BalanceDetail, type BalanceDetailProps } from "./balance-detail";

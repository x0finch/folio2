// @folio/detail-block —— 单持仓 DetailSection 渲染器(DetailBlock 重设计,per-balance)。
// <HoldingDetail sections={balance.detail} formatNumber={…}/> 把一笔持仓的 DetailSection[] 渲染成一块内容:
// 每 section 一段(段首状态 icon 名 → lucide + 段标题,下接 content string/rows,行 href 包外链)。
// app 侧用 beUI BouncyAccordion 组装:每笔带 detail 的持仓 = 一个手风琴 item,item.icon = 币 logo,
// item 展开区 = <HoldingDetail>。数字 locale 格式化由 app 注入 formatNumber(通用包不直接依赖 use-intl / @folio/fx)。
export { HoldingDetail, type HoldingDetailProps } from "./holding-detail";

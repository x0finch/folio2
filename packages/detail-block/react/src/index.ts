// @folio/detail-block —— DetailBlock 通用渲染器 + 原语组件(ADR 0010)。
// <BalanceDetail blocks={detail}/> 按块 type 分派到 stat/keyValue/addressList 原语,永不判断业务身份;
// 未知块跳过、缺字段不画。i18n / 货币格式化经 DetailRenderContext 由 app 注入(包不直接依赖 use-intl / @folio/fx)。
export { BalanceDetail, type BalanceDetailProps } from "./balance-detail";
export type { DetailRenderContext } from "./detail-context";

import { LogoAvatar } from "@folio/ui";
import type { ReactNode } from "react";
import { AvatarStack } from "../../../../../components/avatar-stack";
import { formatNumber } from "../../../../../lib/format-number";
import { ValueDelta } from "../value-delta";

// 全站统一的「代币持仓行」内容(主页 Tokens 视图 + 账户详情抽屉现货区共用)。
// 单个 flex 容器 —— SharedLayoutBg 会把子元素塞进非 flex 的 z-10 div,故 flex 放这层内层。
// 左:logo + 名称(可接多源叠标 / note aside)+ 数量·symbol;右:<ValueDelta>(市值 + 24h 单符号增量)。
// 纯展示层:不含点击/排序 —— 主页包成可点行(→ 资产抽屉),账户抽屉静态渲染,排序由调用方决定。
export interface TokenRowItem {
  logo?: string;
  name: string;
  symbol: string;
  amount?: number | null;
  value: number;
  // 24h 盈亏(ADR 0040),由 server 按快照历史 / 账本分段算好。`null` = 算不出 → `—`。
  gain24h?: { amount: number; pct: number | null } | null;
}

export function TokenRowContent({
  item,
  sources,
  aside,
  gainPending = false,
}: {
  item: TokenRowItem;
  // 多源(主页跨链/多账户汇总)→ 名称右侧叠放各来源 logo;单账户抽屉不传。
  sources?: { logo?: string; name: string; k: string }[];
  // 行内附加物(如账户抽屉的 balance 级 note 指示器);无则省略。
  aside?: ReactNode;
  /** 24h 盈亏还在取 —— 市值照常,增量位走小骨架。 */
  gainPending?: boolean;
}) {
  // 24h 盈亏(ADR 0040)由 server 算好 —— 过渡期那条「没接上就回落到市场涨跌幅倒推」的路已经拆了,
  // 主页与账户抽屉两条路都接上了(#447 第 2 / 5 片)。`null` = 算不出 → `—`。
  // 三态原样透传:缺席 = 这个位置不该有(整行省略);`null` = 算不出(`—`);有对象才取金额。
  // `?.amount ?? null` 会把「不该有」压成「算不出」。
  const dayValue = item.gain24h === undefined ? undefined : (item.gain24h?.amount ?? null);
  const dayPct = item.gain24h === undefined ? undefined : (item.gain24h?.pct ?? null);
  return (
    <div className="flex w-full items-center gap-3">
      <LogoAvatar src={item.logo} fallback={item.symbol} size="md" />
      <div className="min-w-0 flex-1">
        {/* min-w-0 让名称在 flex 里可收缩截断,叠 logo/aside(shrink-0)才不会被挤出框、被价值列盖住。 */}
        <div className="flex min-w-0 items-center gap-1.5">
          {/* select-text:代币名是内容,长按要能选中复制(行本身是按钮 → base 层不可选)。 */}
          <span className="min-w-0 select-text truncate font-medium">{item.name}</span>
          {sources && sources.length > 1 ? <AvatarStack items={sources} /> : null}
          {aside}
        </div>
        {item.amount != null && (
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatNumber(item.amount)} {item.symbol}
          </span>
        )}
      </div>
      <ValueDelta value={item.value} delta={dayValue} pct={dayPct} loading={gainPending} />
    </div>
  );
}

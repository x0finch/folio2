import { LogoAvatar } from "@folio/ui";
import type { ReactNode } from "react";
import { dayValueChange } from "../lib/day-value-change";
import { formatNumber } from "../lib/format-number";
import { AvatarStack } from "./avatar-stack";
import { ValueDelta } from "./value-delta";

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
  change24h?: number;
  // 24h 盈亏(ADR 0040),由 server 按快照历史分段算好。`null` = 算不出 → `—`。
  // **`undefined` = 这条路还没接上盈亏**,回落到旧的市场涨跌幅倒推 —— 账户抽屉的现货区暂时如此
  // (#447 第 5 片接)。过渡期的两条路都得能显示,不然抽屉里那一列会先空掉。
  gain24h?: { amount: number; pct: number | null } | null;
}

export function TokenRowContent({
  item,
  sources,
  aside,
}: {
  item: TokenRowItem;
  // 多源(主页跨链/多账户汇总)→ 名称右侧叠放各来源 logo;单账户抽屉不传。
  sources?: { logo?: string; name: string; k: string }[];
  // 行内附加物(如账户抽屉的 balance 级 note 指示器);无则省略。
  aside?: ReactNode;
}) {
  const wired = item.gain24h !== undefined;
  const dayValue = wired
    ? (item.gain24h?.amount ?? null)
    : dayValueChange(item.value, item.change24h);
  const dayPct = wired ? (item.gain24h?.pct ?? null) : item.change24h;
  return (
    <div className="flex w-full items-center gap-3">
      <LogoAvatar src={item.logo} fallback={item.symbol} size="md" />
      <div className="min-w-0 flex-1">
        {/* min-w-0 让名称在 flex 里可收缩截断,叠 logo/aside(shrink-0)才不会被挤出框、被价值列盖住。 */}
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate font-medium">{item.name}</span>
          {sources && sources.length > 1 ? <AvatarStack items={sources} /> : null}
          {aside}
        </div>
        {item.amount != null && (
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatNumber(item.amount)} {item.symbol}
          </span>
        )}
      </div>
      <ValueDelta value={item.value} delta={dayValue} pct={dayPct} />
    </div>
  );
}

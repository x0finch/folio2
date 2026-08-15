import type { ReactNode } from "react";

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2.5 px-3">
      <span className="text-muted-foreground text-xs uppercase tracking-widest">{title}</span>
    </div>
  );
}

// 按小计倒序的分区列表(section list,ADR 0034)—— 自定义 Tab 视图的展示骨架。
// 现货 / 永续 / DeFi 各一段竖排,**哪段小计大哪段在上**;空段(count=0)剔除。generic:调用方(④)把
// 具体的 TokenHoldings / PerpPositionsList / DefiPositions 作为各段 content 传进来,本组件只管排序 + 加节头。
// 默认 / Portfolio 视图仍走现有的现货/永续/DeFi 子 Tab —— 本组件只服务自定义 Tab。

export interface OverviewSection {
  key: string;
  title: string; // eyebrow 节头文案
  subtotal: number; // 该段市值小计(排序键)
  count: number; // 该段条目数;0 = 空段,剔除
  content: ReactNode; // 该段的具体渲染(TokenHoldings / PerpPositionsList / DefiPositions)
}

// 排序键取有限值,否则当 0:防某段小计意外为 NaN 时,`NaN - x` 得 NaN(falsy)悄悄落到 key
// tiebreak、把该段排到与其数值无关的位置。负小计(如永续负权益)本就比较正确,无需特殊处理。
const subtotalKey = (n: number): number => (Number.isFinite(n) ? n : 0);

// 纯排序:剔除空段 → 按小计倒序(平手用 key 稳定 tiebreak,避免同值顺序抖动)。
export function orderSections<T extends { key: string; subtotal: number; count: number }>(
  sections: T[],
): T[] {
  return sections
    .filter((s) => s.count > 0)
    .sort(
      (a, b) => subtotalKey(b.subtotal) - subtotalKey(a.subtotal) || a.key.localeCompare(b.key),
    );
}

export function SectionList({ sections }: { sections: OverviewSection[] }) {
  const ordered = orderSections(sections);
  if (ordered.length === 0) return null;
  return (
    <div className="flex flex-col gap-6">
      {ordered.map((s, i) => (
        <div key={s.key} className="flex flex-col gap-3">
          {/* 首段(最大)省略 eyebrow 节头 —— 它已是默认焦点,再加标题显冗余(ADR 0034 UI 微调)。 */}
          {i > 0 && <SectionHeader title={s.title} />}
          {s.content}
        </div>
      ))}
    </div>
  );
}

import type { ReactNode } from "react";
import { SectionHeader } from "./holdings-sections";

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

// 纯排序:剔除空段 → 按小计倒序(平手用 key 稳定 tiebreak,避免同值顺序抖动)。
export function orderSections<T extends { key: string; subtotal: number; count: number }>(
  sections: T[],
): T[] {
  return sections
    .filter((s) => s.count > 0)
    .sort((a, b) => b.subtotal - a.subtotal || a.key.localeCompare(b.key));
}

export function SectionList({ sections }: { sections: OverviewSection[] }) {
  const ordered = orderSections(sections);
  if (ordered.length === 0) return null;
  return (
    <div className="flex flex-col gap-6">
      {ordered.map((s) => (
        <div key={s.key} className="flex flex-col gap-3">
          <SectionHeader title={s.title} />
          {s.content}
        </div>
      ))}
    </div>
  );
}

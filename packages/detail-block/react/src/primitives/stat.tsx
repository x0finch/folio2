import type { StatBlock } from "@folio/detail-block-basic";
import { useDetailContext } from "../detail-context";

// stat 原语:带标签的单个数值(如账户净未确认额)。label 经 i18n、value 按 format 格式化。
export function Stat({ block }: { block: StatBlock }) {
  const { translate, format } = useDetailContext();
  if (block.value == null) return null; // 缺字段不画(旧快照优雅降级)
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{translate(block.label)}</span>
      <span className="font-medium">{format(block.value, block.format, block.unit)}</span>
    </div>
  );
}

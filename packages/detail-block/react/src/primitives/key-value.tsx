import type { KeyValueBlock } from "@folio/detail-block-basic";
import { useDetailContext } from "../detail-context";

// keyValue 原语:键值对列表(如 CEX 的 locked / available)。可选块级标题(i18n key)。
export function KeyValue({ block }: { block: KeyValueBlock }) {
  const { translate, format } = useDetailContext();
  const items = (block.items ?? []).filter((it) => it.label != null); // 缺 label 的项不画
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {block.label != null && <p className="text-sm font-medium">{translate(block.label)}</p>}
      <div className="flex flex-col divide-y divide-border/60">
        {items.map((item) => (
          <div key={item.label} className="flex items-center justify-between gap-3 py-1.5 text-sm">
            <span className="text-muted-foreground">{translate(item.label)}</span>
            <span className="font-medium">{format(item.value, item.format, item.unit)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

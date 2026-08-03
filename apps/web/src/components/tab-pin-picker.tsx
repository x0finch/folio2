import { useTranslations } from "use-intl";
import { tagColor } from "../lib/tag-color";

// 自定义 Tab 的添加/改指向选择器(ADR 0034):内联下推面板(memory:选择器用内联下推,不用 beUI Popover/Select),
// 分两 section —— 按 Connector / 按 Tag。选中即回调 onPick。空(无 connector 也无 tag)显空态。
export interface PinTargetChoice {
  kind: "connector" | "tag";
  connectorId?: string;
  tagId?: string;
}

export function TabPinPicker({
  connectorOptions,
  tagOptions,
  onPick,
}: {
  connectorOptions: { id: string; label: string }[];
  tagOptions: { id: string; name: string }[];
  onPick: (choice: PinTargetChoice) => void;
}) {
  const t = useTranslations("CustomTabs");
  const empty = connectorOptions.length === 0 && tagOptions.length === 0;
  return (
    <div className="flex w-56 flex-col gap-3 rounded-xl border border-border bg-popover p-3 shadow-lg">
      {empty && <div className="px-1 py-2 text-muted-foreground text-sm">{t("noOptions")}</div>}
      {connectorOptions.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <div className="px-2 py-1 text-muted-foreground text-xs uppercase tracking-widest">
            {t("byConnector")}
          </div>
          {connectorOptions.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onPick({ kind: "connector", connectorId: c.id })}
              className="rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      {tagOptions.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <div className="px-2 py-1 text-muted-foreground text-xs uppercase tracking-widest">
            {t("byTag")}
          </div>
          {tagOptions.map((tg) => (
            <button
              key={tg.id}
              type="button"
              onClick={() => onPick({ kind: "tag", tagId: tg.id })}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
            >
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: tagColor(tg.id) }}
              />
              {tg.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

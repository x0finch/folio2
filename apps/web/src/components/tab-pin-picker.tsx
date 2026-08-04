import { cn, SharedLayoutBg } from "@folio/ui";
import { Check } from "lucide-react";
import { useTranslations } from "use-intl";

// 自定义 Tab 的添加/改指向选择器(ADR 0034):**裸内容**,面板 chrome 由承载它的 beUI hover Popover 提供
//(＋按钮 / pin 药丸 hover 弹出)。分三段 —— Tag / Connector / Account。选中即回调 onPick;空显空态。
// selected 传入当前指向 → 命中项右侧打勾(改指向面板用;添加面板不传)。行内 hover 高亮走 SharedLayoutBg
// 滑动药丸。三段现在渲染一致(纯 name + 勾,tag 不再带色点),抽成 PickerSection。
export interface PinTargetChoice {
  kind: "connector" | "tag" | "account";
  connectorId?: string;
  tagId?: string;
  accountId?: string;
}

const headerClass = "px-2 py-1 text-muted-foreground text-xs uppercase tracking-widest";
const rowClass = "rounded-md px-2 py-1.5 text-left text-sm";

function PickerSection({
  header,
  options,
  activeId,
  onPick,
}: {
  header: string;
  options: { id: string; label: string }[];
  activeId?: string;
  onPick: (id: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <div className={headerClass}>{header}</div>
      <SharedLayoutBg className="gap-0.5" inset={0} pillClassName="rounded-md bg-muted">
        {options.map((o) => (
          <button key={o.id} type="button" onClick={() => onPick(o.id)} className={rowClass}>
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              <Check
                className={cn("size-4 shrink-0", activeId === o.id ? "opacity-100" : "opacity-0")}
              />
            </span>
          </button>
        ))}
      </SharedLayoutBg>
    </div>
  );
}

export function TabPinPicker({
  connectorOptions,
  tagOptions,
  accountOptions,
  selected,
  onPick,
}: {
  connectorOptions: { id: string; label: string }[];
  tagOptions: { id: string; name: string }[];
  accountOptions: { id: string; label: string }[];
  selected?: PinTargetChoice;
  onPick: (choice: PinTargetChoice) => void;
}) {
  const t = useTranslations("CustomTabs");
  const empty =
    connectorOptions.length === 0 && tagOptions.length === 0 && accountOptions.length === 0;
  // 选项多(尤其 Tag/Account 无上限)时整份选择器限高 + 竖向滚动 —— 面板不无限撑高、不越过视口(用户要求)。
  return (
    <div className="flex max-h-64 min-w-44 flex-col gap-3 overflow-y-auto">
      {empty && <div className="px-1 py-2 text-muted-foreground text-sm">{t("noOptions")}</div>}
      <PickerSection
        header={t("byTag")}
        options={tagOptions.map((tg) => ({ id: tg.id, label: tg.name }))}
        activeId={selected?.kind === "tag" ? selected.tagId : undefined}
        onPick={(id) => onPick({ kind: "tag", tagId: id })}
      />
      <PickerSection
        header={t("byConnector")}
        options={connectorOptions}
        activeId={selected?.kind === "connector" ? selected.connectorId : undefined}
        onPick={(id) => onPick({ kind: "connector", connectorId: id })}
      />
      <PickerSection
        header={t("byAccount")}
        options={accountOptions}
        activeId={selected?.kind === "account" ? selected.accountId : undefined}
        onPick={(id) => onPick({ kind: "account", accountId: id })}
      />
    </div>
  );
}

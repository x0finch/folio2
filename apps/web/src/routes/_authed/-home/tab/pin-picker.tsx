import { cn, SharedLayoutBg } from "@folio/ui";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useTranslations } from "use-intl";
import { connectorLabelFallback } from "@/lib/core/logo";
import { connectorCatalogQuery } from "@/lib/queries/connectors";
import { PinTargetMark } from "./pin-target-mark";

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

// 选择器用:仍走连接器目录(打开选择器才拉)。tab 条不要用它 —— 一挂就打目录。
function PinTargetLabel({
  target,
  name,
  onPrimary,
  className,
}: {
  target: PinTargetChoice;
  name?: string; // tag / account 的名字(connector 走 registry 类型名,不用它)
  onPrimary?: boolean; // 落在激活药丸(bg-primary 浅底)上 → logo 底盘随之改色
  className?: string;
}) {
  const { data: catalog } = useQuery(connectorCatalogQuery());
  const id = target.connectorId ?? "";
  const resolvedName =
    target.kind === "connector"
      ? (catalog?.[id]?.label ?? connectorLabelFallback(id))
      : (name ?? "");
  const logo = target.kind === "connector" ? catalog?.[id]?.logo : undefined;
  return (
    <PinTargetMark
      kind={target.kind}
      name={resolvedName}
      logo={logo}
      onPrimary={onPrimary}
      className={className}
    />
  );
}

function PickerSection({
  header,
  kind,
  options,
  activeId,
  onPick,
}: {
  header: string;
  kind: PinTargetChoice["kind"];
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
              {/* 前导标记与 pin 药丸同一份渲染(PinTargetLabel)→ 选择器里看到什么,固定后药丸就是什么。 */}
              <PinTargetLabel
                target={targetOf(kind, o.id)}
                name={o.label}
                className="min-w-0 flex-1"
              />
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

// (kind, id) → PinTargetChoice。选项行渲染标记与 onPick 回调用的是同一个形状。
function targetOf(kind: PinTargetChoice["kind"], id: string): PinTargetChoice {
  if (kind === "tag") return { kind, tagId: id };
  if (kind === "account") return { kind, accountId: id };
  return { kind, connectorId: id };
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
        kind="tag"
        options={tagOptions.map((tg) => ({ id: tg.id, label: tg.name }))}
        activeId={selected?.kind === "tag" ? selected.tagId : undefined}
        onPick={(id) => onPick({ kind: "tag", tagId: id })}
      />
      <PickerSection
        header={t("byConnector")}
        kind="connector"
        options={connectorOptions}
        activeId={selected?.kind === "connector" ? selected.connectorId : undefined}
        onPick={(id) => onPick({ kind: "connector", connectorId: id })}
      />
      <PickerSection
        header={t("byAccount")}
        kind="account"
        options={accountOptions}
        activeId={selected?.kind === "account" ? selected.accountId : undefined}
        onPick={(id) => onPick({ kind: "account", accountId: id })}
      />
    </div>
  );
}

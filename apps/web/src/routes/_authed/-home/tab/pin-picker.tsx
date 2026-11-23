import { cn, SharedLayoutBg } from "@folio/ui";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useTranslations } from "use-intl";
import { connectorLabelFallback } from "@/lib/core/logo";
import { connectorCatalogQuery } from "@/lib/queries/connectors";
import { PinTargetMark } from "./pin-target-mark";

// Bare picker content (panel chrome comes from the hosting beUI Popover) with three sections: Tag /
// Connector / Account. Picking calls onPick; `selected` marks the current target with a check
// (change-target panel only).
export interface PinTargetChoice {
  kind: "connector" | "tag" | "account";
  connectorId?: string;
  tagId?: string;
  accountId?: string;
}

const headerClass = "px-2 py-1 text-muted-foreground text-xs uppercase tracking-widest";
const rowClass = "rounded-md px-2 py-1.5 text-left text-sm";

// Uses the connector catalog (fetched on open). The tab strip must not use this: it would fetch the catalog on mount.
function PinTargetLabel({
  target,
  name,
  onPrimary,
  className,
}: {
  target: PinTargetChoice;
  name?: string; // tag / account name (connectors use the registry type name)
  onPrimary?: boolean; // on the active pill (light bg-primary): the logo backing recolors
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
              {/* Same mark as the pin pill (PinTargetLabel), so the picker previews the pill. */}
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

// (kind, id) -> PinTargetChoice, the shape used for both the row mark and onPick.
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
  // Cap the height and scroll vertically: Tag/Account options are unbounded.
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

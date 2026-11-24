import type { ConnectorId } from "@folio/connectors";
import { LogoAvatar, SharedLayoutBg } from "@folio/ui";
import { useQuery } from "@tanstack/react-query";
import { connectorLabelFallback } from "@/lib/core/logo";
import { connectorCatalogQuery } from "@/lib/queries/connectors";

// Hardcoded add-account groups; `group` is only a display heading. The client imports ConnectorId
// as a type only, to keep the registry out of the client bundle.
const CONNECTOR_OPTIONS: { group: string; options: ConnectorId[] }[] = [
  { group: "Manual", options: ["manual"] },
  { group: "On-chain", options: ["evm", "bitcoin", "solana", "sui", "cosmos"] },
  { group: "Exchange", options: ["binance", "okx", "bybit"] },
  { group: "Perp DEX", options: ["hyperliquid"] },
];

// First step of adding an account: a pure-display grid with a single SharedLayoutBg pill morphing
// across all groups. Group headings are non-interactive col-span-full children (pointer-events-none),
// tiles are the cells (inset=0). Logo load failures fall back to initials in LogoAvatar.
export function ConnectorGrid({ onSelect }: { onSelect: (connectorId: ConnectorId) => void }) {
  const { data: catalog } = useQuery(connectorCatalogQuery());
  return (
    <SharedLayoutBg
      className="grid grid-cols-2 gap-2 sm:grid-cols-3"
      inset={0}
      pillClassName="rounded-xl bg-muted"
    >
      {CONNECTOR_OPTIONS.flatMap((group) => [
        // Group heading: full row, outside the pill; no top margin for the first group.
        <div
          key={`group-${group.group}`}
          className="col-span-full pt-3 text-muted-foreground text-xs first:pt-0 pointer-events-none"
        >
          {group.group}
        </div>,
        ...group.options.map((id) => {
          const label = catalog?.[id]?.label ?? connectorLabelFallback(id);
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              className="group w-full rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {/* Padding lives in this inner container so the button itself doesn't clip the pill. */}
              <div className="flex flex-col items-start gap-2 rounded-xl p-3">
                <LogoAvatar src={catalog?.[id]?.logo} fallback={label} size="sm" alt="" />
                <span className="font-medium text-sm">{label}</span>
              </div>
            </button>
          );
        }),
      ])}
    </SharedLayoutBg>
  );
}

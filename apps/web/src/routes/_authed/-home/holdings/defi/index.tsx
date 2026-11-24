import { cn, LogoAvatar, Popover, PopoverContent, PopoverTrigger, SharedLayoutBg } from "@folio/ui";
import { useEffect, useRef } from "react";
import { useTranslations } from "use-intl";
import { Sensitive } from "@/components/sensitive";
import type { DefiGroup, DefiRow } from "@/lib/core/account-view";
import { defiMeaningfulLegs, groupLegsByRole } from "@/lib/core/account-view";
import { formatNumber } from "@/lib/core/format-number";
import { defiLogoUrl } from "@/lib/core/logo";
import { useDisplayValue } from "@/lib/hooks/use-display-value";
import { useHoverPopover } from "@/lib/hooks/use-hover-popover";
import { ValueDelta } from "@/routes/_authed/-home/holdings/value-delta";

// DeFi holdings detail, shared by the overview "DeFi" tab and the account drawer. Row-style like the
// token rows; red/green only mean PnL and debt, the type is a fact, not a judgment.

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2.5 px-3">
      <span className="text-muted-foreground text-xs uppercase tracking-widest">{title}</span>
    </div>
  );
}

// Debt leg: "−" in neutral color (debt is not a loss; red/green are for price moves).
const legText = (r: DefiRow) =>
  `${r.usdValue < 0 ? "−" : ""}${formatNumber(Math.abs(r.amount))} ${r.symbol}`;

// Role -> chart color. Data-viz is the one exception to design tokens but still uses --chart-* tokens;
// /50 opacity softens the segments. Debt segments take no color (neutral stripes).
const CHART_BG = [
  "bg-chart-1/50",
  "bg-chart-2/50",
  "bg-chart-3/50",
  "bg-chart-4/50",
  "bg-chart-5/50",
] as const;

// Fixed color for asset-like roles (deposit/supply...); debt roles use stripes. Fixed slots are
// excluded from the hash pool so they never collide with hashed roles.
const FIXED_ROLE_IDX: Record<string, number> = {
  deposit: 0,
  supply: 0,
  supplied: 0,
};
const RESERVED_IDX = new Set(Object.values(FIXED_ROLE_IDX));
const HASH_POOL = CHART_BG.map((_, i) => i).filter((i) => !RESERVED_IDX.has(i));

// Fixed roles get fixed colors, others hash(role) % pool, so a role name has the same color across protocols.
function roleColorIdx(role: string): number {
  const key = role.toLowerCase();
  const fixed = FIXED_ROLE_IDX[key];
  if (fixed != null) return fixed;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return HASH_POOL[Math.abs(h) % HASH_POOL.length];
}

// Debt segment: neutral background with fine stripes (not --neg: debt is not a loss).
const DEBT_SEG_STYLE: React.CSSProperties = {
  backgroundColor: "var(--muted-foreground)",
  backgroundImage: "repeating-linear-gradient(45deg, transparent 0 3px, var(--background) 3px 4px)",
};

interface RoleSeg {
  role?: string;
  legs: DefiRow[];
  gross: number; // segment width = the role's gross exposure, sum of |usd|
  debt: boolean; // role is net negative
  colorIdx: number | null; // chart color index; null for debt
}

// Groups valued legs by role into bar segments; a net-negative role is debt (no color), others hash(role).
function toRoleSegs(rows: DefiRow[]): RoleSeg[] {
  return groupLegsByRole(defiMeaningfulLegs(rows)).map((g) => {
    const gross = g.legs.reduce((s, r) => s + Math.abs(r.usdValue), 0);
    const debt = g.legs.reduce((s, r) => s + r.usdValue, 0) < 0;
    return {
      role: g.role,
      legs: g.legs,
      gross,
      debt,
      colorIdx: debt ? null : roleColorIdx(g.role ?? ""),
    };
  });
}

// Display weights (percent, summing to 100 so flexGrow reads as a percentage): segments below
// MIN% are raised to MIN% so small roles stay visible, the rest split the remainder by gross exposure.
const DEFI_BAR_MIN_SEG_PCT = 5;

function displayWeights(segs: RoleSeg[]): number[] {
  const n = segs.length;
  if (n === 0) return [];
  const total = segs.reduce((s, x) => s + x.gross, 0);
  if (total <= 0) return segs.map(() => 100 / n); // all zero: split evenly
  const MIN = DEFI_BAR_MIN_SEG_PCT;
  const small = segs.map((s) => (s.gross / total) * 100 < MIN);
  const reserved = small.filter(Boolean).length * MIN;
  const largeTotal = segs.reduce((s, x, i) => (small[i] ? s : s + x.gross), 0);
  const remaining = Math.max(0, 100 - reserved);
  // largeTotal === 0 only when every segment is small: all take MIN.
  return segs.map((s, i) =>
    small[i] || largeTotal <= 0 ? MIN : (s.gross / largeTotal) * remaining,
  );
}

// Composition bar: a 4px bar under the protocol name, segmented by role (width = gross share), role
// names above aligned to segment widths and hidden as a whole when they don't fit (opacity:0 keeps
// the space). The whole block is a hover trigger for a per-role detail popover (useHoverPopover).
function CompositionBar({ segs, label }: { segs: RoleSeg[]; label: string }) {
  const usd = useDisplayValue();
  const pop = useHoverPopover();
  const labelsRef = useRef<HTMLDivElement>(null);
  // Hide all labels when they overflow; ResizeObserver re-measures on width changes, and `fitKey`
  // re-runs on segment changes (container width stays the same then, so the observer doesn't fire).
  const fitKey = segs.map((s) => `${s.role ?? ""}:${s.gross}`).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: fitKey isn't referenced in the body but re-measures labels after segment widths change
  useEffect(() => {
    const el = labelsRef.current;
    if (!el) return;
    const measure = () => {
      for (const lab of el.querySelectorAll<HTMLElement>("[data-lab]")) {
        lab.style.opacity = "";
        if (lab.clientWidth < lab.scrollWidth) lab.style.opacity = "0";
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitKey]);

  // Segment weights (sum 100): small ones raised to 5%, shared by labels and segments so they
  // align; summing to 100 also fixes flex-grow factors < 1 not filling the container (sub-dollar protocols).
  const weights = displayWeights(segs);

  return (
    // pt reserves room for the role names, which are absolutely positioned above the bar so root top = bar top.
    <div className="mt-1 ml-9 pt-4">
      <Popover
        trigger="hover"
        side={pop.side}
        align="start"
        onOpenChange={pop.onOpenChange}
        className={cn("w-full", pop.rootClassName)}
      >
        {/* Transparent hover catcher joining role names, bar and a strip below into one hover area
            (the root's in-flow box is only the 4px bar). Absolute, so the anchor stays the bar. No
            aria-hidden: useHoverPopover's closed state would hide it and it couldn't catch hover. */}
        <div className="absolute inset-x-0 -top-4 -bottom-3.5" />
        {/* Role names sit above the bar but stay DOM children of the Popover root (beUI's mouseenter
            fires per DOM subtree), and take no in-flow space so the panel and goo pill anchor to the
            bar. Hidden via fit when they don't fit. */}
        <div ref={labelsRef} className="absolute bottom-full left-0 mb-0.5 flex w-full gap-0.5">
          {segs.map((s, i) => (
            <div
              key={s.role ?? `_${i}`}
              data-lab
              style={{ flexGrow: weights[i], flexBasis: 0 }}
              className="min-w-0 overflow-hidden whitespace-nowrap font-medium text-[10px] text-muted-foreground capitalize"
            >
              {s.role}
            </div>
          ))}
        </div>
        <PopoverTrigger>
          {/* The trigger wraps only the thin bar, so the goo pill is the bar's size and hidden behind it. */}
          <button
            ref={pop.measureRef}
            type="button"
            aria-label={label}
            className="block w-full cursor-default outline-none"
          >
            {/* The 4px bar: segmented by role; debt gets neutral stripes, others chart colors. */}
            <div className="flex h-1 gap-0.5 overflow-hidden rounded-full bg-muted">
              {segs.map((s, i) => (
                <div
                  key={s.role ?? `_${i}`}
                  style={{
                    flexGrow: weights[i],
                    flexBasis: 0,
                    ...(s.debt ? DEBT_SEG_STYLE : {}),
                  }}
                  className={cn("min-w-0", s.colorIdx != null && CHART_BG[s.colorIdx])}
                />
              ))}
            </div>
          </button>
        </PopoverTrigger>
        <PopoverContent>
          {/* Full detail per role (colored swatch matches the bar), all valued legs with USD values;
              debt in neutral "−". Spacing: gap-2.5 between groups, gap-1 within; the panel has its own p-4. */}
          <div className="flex min-w-52 flex-col gap-2.5">
            <div className="font-medium text-sm">{label}</div>
            {segs.map((s, i) => (
              <div key={s.role ?? `_${i}`} className="flex flex-col gap-1">
                {s.role && (
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                    <span
                      style={s.debt ? DEBT_SEG_STYLE : undefined}
                      className={cn(
                        "size-2 shrink-0 rounded-[2px]",
                        s.colorIdx != null && CHART_BG[s.colorIdx],
                      )}
                    />
                    {s.role}
                  </div>
                )}
                {s.legs.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-baseline justify-between gap-8 text-xs tabular-nums"
                  >
                    {/* Masks amount and USD value of legs in the hover detail. */}
                    <span>
                      <Sensitive>{legText(r)}</Sensitive>
                    </span>
                    <span className="text-muted-foreground">
                      <Sensitive>
                        {r.usdValue < 0 ? "−" : ""}
                        {usd(Math.abs(r.usdValue))}
                      </Sensitive>
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// DeFi protocol row: logo + name with <ValueDelta> on the right, and a composition bar below. The
// hover trigger is only the bar, so scanning the list doesn't pop overlays.
function DefiProtocolRowContent({
  group,
  gainPending,
}: {
  group: DefiGroup;
  gainPending: boolean;
}) {
  const subtotal = group.rows.reduce((s, r) => s + r.usdValue, 0);
  // 24h PnL: the protocol's current net value minus 24h ago. The percentage denominator is the
  // start net value (`gain24h.start`); cross-account merges recompute it (see `mergeDefiGroups`).
  // Position changes (deposits/withdrawals) show up in this number by design.
  const change = group.gain24h;
  const segs = toRoleSegs(group.rows);
  return (
    <div className="w-full">
      <div className="flex w-full items-center gap-3">
        {/* Protocol logo via /api/logo/defi, initials fallback. */}
        <LogoAvatar
          src={defiLogoUrl(group.protocol, group.protocolLogo)}
          fallback={group.protocol}
          size="sm"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{group.protocol}</div>
        </div>
        {/* Right: protocol net subtotal + aggregated 24h delta. If the whole protocol is not
            computable show `—`; while loading a small skeleton, not the dash. */}
        <ValueDelta
          value={subtotal}
          delta={change?.amount ?? null}
          pct={change?.pct}
          loading={gainPending}
        />
      </div>
      <CompositionBar segs={segs} label={group.protocol} />
    </div>
  );
}

// DeFi section: one row per protocol (overview passes cross-account merged groups, the drawer a single account's).
// hideHeader: the overview has its own "DeFi" tab, so the header is redundant.
export function DefiPositions({
  groups,
  hideHeader,
  gainPending = false,
}: {
  groups: DefiGroup[];
  hideHeader?: boolean;
  /** PnL still loading: value renders, the delta slot shows a small skeleton. Not passed by the account drawer. */
  gainPending?: boolean;
}) {
  const t = useTranslations("Overview");
  return (
    <section className="flex flex-col gap-3">
      {!hideHeader && <SectionHeader title={t("defiSectionTitle")} />}
      <SharedLayoutBg inset={0} pillClassName="rounded-xl bg-muted">
        {groups.map((g) => (
          // Lift the row above siblings while its inline popover is open (same as perp rows).
          <div
            key={g.protocol}
            className="group rounded-xl px-3 py-1.5 has-[[data-state=open]]:z-20"
          >
            <DefiProtocolRowContent group={g} gainPending={gainPending} />
          </div>
        ))}
      </SharedLayoutBg>
    </section>
  );
}

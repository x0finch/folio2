import { TOP_TOKENS_LIMIT } from "@folio/oracle-basic";
import { cn, Input, LogoAvatar } from "@folio/ui";
import {
  ChevronDown as ChevronDownIcon,
  CircleAlert as CircleAlertIcon,
  Loader2 as Loader2Icon,
  SearchX as SearchXIcon,
  X as XIcon,
} from "@folio/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { formatNumber } from "@/lib/core/format-number";
import type { TokenOption } from "@/lib/core/token-model";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { fiatOptionsQuery, tokenCatalogueQuery, tokenSearchQuery } from "@/lib/queries/tokens";
import { refreshTokenPrices } from "@/lib/server/tokens";
import {
  buildTokenSections,
  type LivePrice,
  matchSegments,
  needsRemoteSearch,
  searchCatalogue,
  staleTickets,
  type TokenSectionKey,
} from "./token-search";

// Expands inline (pushing content down) instead of a second overlay. The full catalogue is
// prefetched on mount and filtered locally; the upstream search is hit (debounced) only when
// local results run short, i.e. for long-tail tokens.

// Mirrors beUI's EASE_OUT token (@folio/ui doesn't export lib/ease).
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

const SECTION_LABEL: Record<TokenSectionKey, "sectionOwned" | "sectionFiat" | "sectionCatalogue"> =
  {
    owned: "sectionOwned",
    fiat: "sectionFiat",
    catalogue: "sectionCatalogue",
  };

// Throttles the upstream search only; local filtering has no network cost.
const SEARCH_DEBOUNCE_MS = 250;
const MIN_SEARCH_LEN = 2;

function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {matchSegments(text, query).map((seg, i) =>
        seg.match ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional segments, static per render
          <span key={i} className="rounded-md bg-accent text-accent-foreground">
            {seg.text}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional segments, static per render
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

function TokenTriggerLabel({ token }: { token: TokenOption }) {
  return (
    <>
      <LogoAvatar src={token.logo} fallback={token.symbol} size="sm" />
      <span className="shrink-0 font-medium">{token.symbol.toUpperCase()}</span>
      <span className="truncate text-muted-foreground">{token.name}</span>
    </>
  );
}

// Omitted when rank is missing.
function RankTag({ rank }: { rank: number }) {
  return <span className="shrink-0 text-muted-foreground text-xs tabular-nums">#{rank}</span>;
}

function TokenListRow({
  token,
  query,
  price,
  change24h,
}: {
  token: TokenOption;
  query?: string;
  price?: number;
  change24h?: number;
}) {
  return (
    <div className="flex w-full items-center gap-3">
      <LogoAvatar src={token.logo} fallback={token.symbol} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-medium">
            {query ? <Highlighted text={token.name} query={query} /> : token.name}
          </span>
          {token.rank != null && <RankTag rank={token.rank} />}
        </div>
        <span className="block truncate text-muted-foreground text-xs">
          {query ? (
            <Highlighted text={token.symbol.toUpperCase()} query={query} />
          ) : (
            token.symbol.toUpperCase()
          )}
        </span>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-sm tabular-nums">
          {price != null ? formatNumber(price, { unit: "$" }) : "—"}
        </div>
        {change24h != null && (
          <div
            className={cn(
              "text-xs tabular-nums",
              change24h > 0 ? "text-pos" : change24h < 0 ? "text-neg" : "text-muted-foreground",
            )}
          >
            {change24h > 0 ? "+" : change24h < 0 ? "-" : ""}
            {Math.abs(change24h).toFixed(2)}%
          </div>
        )}
      </div>
    </div>
  );
}

export function TokenCombobox({
  value,
  onChange,
  onManual,
  owned = [],
}: {
  value: TokenOption | null;
  onChange: (token: TokenOption | null) => void;
  onManual: (query: string) => void;
  // Only the manual-account sidebar passes this.
  owned?: readonly TokenOption[];
}) {
  const t = useTranslations("Accounts");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const search = query.trim();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Prefetched on mount: the user still has to open the dropdown, which leaves time for ~35KB.
  const catalogueQuery = useQuery(tokenCatalogueQuery());
  const catalogue = useMemo(() => catalogueQuery.data ?? [], [catalogueQuery.data]);

  const local = useMemo(() => searchCatalogue(catalogue, search), [catalogue, search]);

  // `settled` keeps `local` and the sent term in sync. Waiting for the catalogue to resolve
  // (success or failure) avoids sending fast typists upstream while local is still empty.
  const debounced = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const settled = debounced === search;
  const wantRemote =
    settled &&
    !catalogueQuery.isLoading &&
    search.length >= MIN_SEARCH_LEN &&
    needsRemoteSearch(local);
  const remoteQuery = useQuery({ ...tokenSearchQuery(search), enabled: open && wantRemote });

  // Tickets are minted server-side; the client never builds token refs. Locale is in the key.
  const locale = useLocale();
  const fiatQuery = useQuery(fiatOptionsQuery(locale));
  const fiat = useMemo(() => fiatQuery.data ?? [], [fiatQuery.data]);

  const sections = useMemo(
    () =>
      buildTokenSections({
        owned,
        fiat,
        catalogue,
        query: search,
        catalogueTopN: TOP_TOKENS_LIMIT,
        remote: remoteQuery.data ?? [],
      }),
    [owned, fiat, catalogue, search, remoteQuery.data],
  );

  const flatItems = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  // `uid` includes the section index: search ordering can split one type into several sections.
  const rendered = useMemo(() => {
    let index = 0;
    return sections.map((s, si) => ({
      uid: `${s.key}:${si}`,
      key: s.key,
      rows: s.items.map((token) => ({ token, index: index++ })),
    }));
  }, [sections]);

  // Price refresh for stale/missing rows. Not a useQuery: results accumulate in one map across
  // search terms, the whole batch goes in a single /simple/price request, and `requested` limits
  // it to once per open. Kept across dropdown open/close (cleared on unmount) so reopening
  // doesn't re-spend CoinGecko quota and compete with /search.
  const [live, setLive] = useState<Map<string, LivePrice>>(() => new Map());
  const requested = useRef<Set<string>>(new Set());

  useEffect(() => {
    // Only after the term settles: each keystroke would otherwise spend quota and push /search
    // into rate limiting on the free tier.
    if (!open || !settled || flatItems.length === 0) return;
    const stale = staleTickets(flatItems, live, requested.current, Date.now());
    if (stale.length === 0) return;
    for (const tk of stale) requested.current.add(tk); // claim first so re-renders don't refire
    let cancelled = false;
    refreshTokenPrices({ data: { tickets: stale } })
      .then((rows) => {
        if (cancelled || rows.length === 0) return;
        setLive((prev) => {
          const next = new Map(prev);
          for (const r of rows) {
            next.set(r.ticket, {
              price: r.unitPrice,
              change24h: r.change24h ?? undefined,
              asOf: r.asOf,
            });
          }
          return next;
        });
      })
      .catch(() => {
        // Best-effort; `requested` is already claimed, so no retry this open.
      });
    return () => {
      cancelled = true;
    };
  }, [open, settled, flatItems, live]);
  // Spin only while nothing is shown; local hits render immediately.
  const isLoading =
    flatItems.length === 0 && (catalogueQuery.isLoading || (wantRemote && remoteQuery.isPending));
  const isError =
    flatItems.length === 0 && (catalogueQuery.isError || (wantRemote && remoteQuery.isError));

  const pick = (token: TokenOption) => {
    // Carry the price already shown so the form doesn't fetch it again.
    const lp = live.get(token.ticket);
    onChange({
      ...token,
      price: lp?.price ?? token.price,
      change24h: lp?.change24h ?? token.change24h,
    });
    setOpen(false);
    setQuery("");
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset active whenever the visible result set changes
  useEffect(() => {
    setActive(0);
  }, [search, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Look up by index, not `[data-active="true"]`: stale DOM nodes could carry an old marker.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    // Keys during IME composition (Enter confirms a candidate) belong to the IME.
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(flatItems.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flatItems[active]) pick(flatItems[active]);
      else if (search) {
        onManual(search);
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // close only the combobox, not the enclosing modal
      setOpen(false);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keydown is delegated from the inner input/buttons; combobox role lives on the field
    <div ref={rootRef} onKeyDown={onKeyDown} className="flex flex-col gap-2">
      {open ? (
        <Input
          autoFocus
          value={query}
          onChange={(v) => setQuery(v)}
          placeholder={t("searchTokenPlaceholder")}
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setQuery("");
            setOpen(true);
          }}
          className="flex h-11 w-full items-center gap-2 rounded-full border border-border bg-background px-4 text-sm outline-none transition-colors hover:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {value ? (
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <TokenTriggerLabel token={value} />
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">
              {t("searchTokenPlaceholder")}
            </span>
          )}
          {value ? (
            <XIcon
              className="shrink-0 text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
              }}
            />
          ) : (
            <ChevronDownIcon className="shrink-0 text-muted-foreground" />
          )}
        </button>
      )}

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <div
              ref={listRef}
              className="max-h-52 overflow-y-auto rounded-xl border border-border bg-card p-1"
            >
              {isError ? (
                <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-destructive text-sm">
                  <CircleAlertIcon />
                  {t("searchFailed")}
                </div>
              ) : flatItems.length > 0 ? (
                // data-index is the flat index so keyboard highlight spans sections.
                rendered.map((section) => (
                  <div key={section.uid}>
                    <div className="px-3 pt-2 pb-1 font-medium text-muted-foreground text-xs">
                      {t(SECTION_LABEL[section.key])}
                    </div>
                    {section.rows.map(({ token, index }) => {
                      const lp = live.get(token.ticket);
                      return (
                        <button
                          key={`${section.uid}:${token.ticket}`}
                          type="button"
                          data-index={index}
                          data-active={index === active}
                          onPointerMove={() => setActive(index)}
                          onClick={() => pick(token)}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                            index === active && "bg-muted",
                          )}
                        >
                          <TokenListRow
                            token={token}
                            query={search}
                            price={lp?.price ?? token.price}
                            change24h={lp?.change24h ?? token.change24h}
                          />
                        </button>
                      );
                    })}
                  </div>
                ))
              ) : isLoading ? (
                <div className="flex items-center justify-center px-3 py-6 text-muted-foreground">
                  <Loader2Icon className="animate-spin" aria-label={t("searching")} />
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-muted-foreground text-sm">
                  <SearchXIcon />
                  {t("noResults")}
                  {search && (
                    <button
                      type="button"
                      onClick={() => {
                        onManual(search);
                        setOpen(false);
                      }}
                      className="font-medium text-foreground underline underline-offset-2"
                    >
                      {t("customEntry", { query: search })}
                    </button>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

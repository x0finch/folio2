import { cn, Skeleton, TabsTrigger, toast } from "@folio/ui";
import { Plus } from "@folio/ui/icons";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import { QueryBoundary } from "@/components/query-boundary";
import { MAX_PINS_PER_PORTFOLIO } from "@/lib/core/accounts-in-view";
import { connectorLabelFallback } from "@/lib/core/logo";
import { useHomeTabStrip } from "@/lib/hooks/use-home-tab-strip";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { accountListQuery } from "@/lib/queries/accounts";
import { connectorCatalogQuery } from "@/lib/queries/connectors";
import { refetchUntil } from "@/lib/queries/constants";
import { fetchHomeTabStrip, type HomeTabStrip } from "@/lib/queries/portfolio";
import { invalidateFor } from "@/lib/queries/refresh";
import { tagListQuery } from "@/lib/queries/tags";
import { createTabPin, deleteTabPin, updateTabPinTarget } from "@/lib/server/tab-pins";
import { kindTabsOf, tabAfterUnpin } from "@/routes/_authed/-home/home-tabs";
import { type PinTargetChoice, TabPinPicker } from "./pin-picker";
import { PinPanel } from "./pin-portal-popover";
import { PinTargetMark } from "./pin-target-mark";
import { useHomeTabSelection } from "./selection";

/** What a pin targets, to tell whether the strip's slot has caught up. Exactly one target column is set per kind. */
const targetOf = (p: PinTargetChoice) => `${p.kind}:${p.connectorId ?? p.tagId ?? p.accountId}`;

/** Waits until the tab strip actually changes: the refresh right after invalidate may still be the old strip. */
const awaitStrip = (
  queryClient: ReturnType<typeof useQueryClient>,
  portfolioId: string,
  ok: (strip: HomeTabStrip) => boolean,
) => refetchUntil(() => fetchHomeTabStrip(queryClient, portfolioId), ok);

// A custom pin: a plain beUI TabsTrigger sharing the sliding pill; the manage panel floats via PinPanel.
export function PinTab({ pin }: { pin: HomeTabStrip["pins"][number] }) {
  const { selectedId } = usePortfolio();
  const queryClient = useQueryClient();
  const strip = useHomeTabStrip(selectedId);
  const { shownActive, selectTab } = useHomeTabSelection(strip.pins);
  const isActive = shownActive === pin.id;
  const selected: PinTargetChoice = {
    kind: pin.kind,
    connectorId: pin.connectorId,
    tagId: pin.tagId,
    accountId: pin.accountId,
  };
  const tct = useTranslations("CustomTabs");
  const failPin = () => toast.error(tct("actionFailed"));
  const repointMut = useMutation({
    mutationFn: (choice: PinTargetChoice) =>
      updateTabPinTarget({ data: { pinId: pin.id, ...choice } }),
    onSuccess: async (_out, choice) => {
      await invalidateFor(queryClient, "portfolio.pin.write");
      // Wait until the strip points at the new target, else it keeps the old name and content.
      await awaitStrip(queryClient, selectedId, (strip) =>
        strip.pins.some((p) => p.id === pin.id && targetOf(p) === targetOf(choice)),
      );
    },
    onError: failPin,
  });
  const unpinMut = useMutation({
    mutationFn: () => deleteTabPin({ data: { pinId: pin.id } }),
    onSuccess: async () => {
      await invalidateFor(queryClient, "portfolio.pin.write");
      await awaitStrip(queryClient, selectedId, (strip) =>
        strip.pins.every((p) => p.id !== pin.id),
      );
    },
    onError: failPin,
  });
  const onUnpin = () => {
    if (shownActive === pin.id) {
      // Unpinning the active tab selects the left neighbour (previous pin, else the last perspective tab).
      selectTab(tabAfterUnpin(pin.id, strip.pins, kindTabsOf(strip.hasPerps, strip.hasDefi)));
    }
    unpinMut.mutate();
  };
  return (
    <PinPanel
      // Must be selected before it opens: the first click only selects (isActive is still false then).
      gate={isActive}
      ghost={
        <span
          className={cn(
            "inline-flex h-full w-full items-center justify-center whitespace-nowrap rounded-full px-4 font-medium text-sm",
            isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground",
          )}
        >
          <PinTargetMark
            kind={selected.kind}
            name={pin.name}
            logo={pin.logo}
            onPrimary={isActive}
          />
        </span>
      }
      panel={(close) => (
        <div className="flex w-56 flex-col gap-2">
          <LazyPinPicker
            selected={selected}
            onPick={(choice) => {
              repointMut.mutate(choice);
              close();
            }}
          />
          {/* Divider separating unpin from the picker above (standalone line, not on a rounded-md button). */}
          <div className="border-border border-t" />
          <button
            type="button"
            onClick={onUnpin}
            disabled={unpinMut.isPending}
            className="rounded-md px-2 py-2 text-left text-destructive text-sm transition-colors hover:bg-destructive/10 disabled:opacity-50"
          >
            {tct("unpin")}
          </button>
        </div>
      )}
    >
      <TabsTrigger value={pin.id}>
        {/* Target mark; onPrimary recolors the logo's backing when the pill is active (light fill). */}
        <PinTargetMark kind={selected.kind} name={pin.name} logo={pin.logo} onPrimary={isActive} />
      </TabsTrigger>
    </PinPanel>
  );
}

// + button: opens the picker via PinPanel.
export function AddPinButton() {
  const { selectedId } = usePortfolio();
  const queryClient = useQueryClient();
  const strip = useHomeTabStrip(selectedId);
  const { selectTab } = useHomeTabSelection(strip.pins);
  const tct = useTranslations("CustomTabs");
  const addMut = useMutation({
    mutationFn: (choice: PinTargetChoice) => createTabPin({ data: choice }),
    onSuccess: async (pin) => {
      // Wait for the new tab to appear on the strip before selecting it, else active points at a
      // tab that isn't there yet and the pill doesn't move.
      await invalidateFor(queryClient, "portfolio.pin.write");
      await awaitStrip(queryClient, selectedId, (strip) => strip.pins.some((p) => p.id === pin.id));
      selectTab(pin.id);
    },
    onError: () => toast.error(tct("actionFailed")),
  });
  // Hidden at the cap. `pins.length` predates the refresh so + stays during the in-flight write;
  // the real cap is server-side (`assertPinCap` in lib/server/tab-pins/create.ts), this just avoids
  // a wasted pick plus an error.
  if (strip.pins.length >= MAX_PINS_PER_PORTFOLIO) return null;
  return (
    <PinPanel
      disabled={addMut.isPending}
      ghost={<Plus className="text-muted-foreground" />}
      panel={(close) => (
        <div className="w-56">
          <LazyPinPicker
            onPick={(choice) => {
              addMut.mutate(choice);
              close();
            }}
          />
        </div>
      )}
    >
      <button
        type="button"
        aria-label={tct("add")}
        disabled={addMut.isPending}
        className="flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        <Plus />
      </button>
    </PinPanel>
  );
}

function PickerSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-4 w-16" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  );
}

function PickerFailed() {
  const tct = useTranslations("CustomTabs");
  return <p className="px-1 py-2 text-muted-foreground text-sm">{tct("actionFailed")}</p>;
}

// Catalog / accounts / tags are fetched only once the picker opens, keeping them off the first-paint path.
function LazyPinPicker({
  selected,
  onPick,
}: {
  selected?: PinTargetChoice;
  onPick: (choice: PinTargetChoice) => void;
}) {
  return (
    <QueryBoundary resetKey="pin-picker" pending={<PickerSkeleton />} failed={<PickerFailed />}>
      <PinPickerOptions selected={selected} onPick={onPick} />
    </QueryBoundary>
  );
}

function PinPickerOptions({
  selected,
  onPick,
}: {
  selected?: PinTargetChoice;
  onPick: (choice: PinTargetChoice) => void;
}) {
  // Options come only from the current portfolio (the server already filters accounts and tags).
  const { selectedId } = usePortfolio();
  const { data: catalog } = useSuspenseQuery(connectorCatalogQuery());
  const { data: accounts } = useSuspenseQuery(accountListQuery(selectedId));
  const { data: tags } = useSuspenseQuery(tagListQuery(selectedId));
  // Archived accounts aren't pinnable: a pin is a perspective to watch, archived is sealed.
  const active = accounts.filter((a) => a.archivedAt == null);
  const connectorOptions = [...new Set(active.map((a) => a.connectorId))].map((id) => ({
    id,
    label: catalog[id]?.label ?? connectorLabelFallback(id),
  }));
  const tagOptions = tags.map((tg) => ({ id: tg.id, name: tg.name }));
  const accountOptions = active.map((a) => ({ id: a.id, label: a.label }));
  return (
    <TabPinPicker
      connectorOptions={connectorOptions}
      tagOptions={tagOptions}
      accountOptions={accountOptions}
      selected={selected}
      onPick={onPick}
    />
  );
}

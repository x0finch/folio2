import {
  AnimatedBadge,
  Button,
  cn,
  Input,
  MorphingModal,
  SharedLayoutBg,
  SwipeableList,
  type SwipeableListClassNames,
  type SwipeableListItem,
  toast,
  useMediaQuery,
} from "@folio/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Pin, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { type PortfolioSummary, usePortfolio } from "@/lib/hooks/use-portfolio";
import { invalidateFor } from "@/lib/queries/refresh";
import {
  createPortfolio,
  deletePortfolio,
  moveAccountToPortfolio,
  renamePortfolio,
  setDefaultPortfolio,
} from "@/lib/server/portfolios";
import { EditableName } from "./editable-name";
import { Portal } from "./portal";

const swipeClasses: SwipeableListClassNames = {
  root: "gap-0",
  item: "rounded-xl bg-background",
  surface:
    "flex min-h-12 items-center rounded-xl border-0 bg-background px-3 py-2 shadow-none transition-colors hover:bg-muted",
  action: "[&>span]:group-hover:bg-muted!",
};

// view.id is both the MorphingModal morph key and the content route.
type View = { id: "list" } | { id: "create" } | { id: "delete"; portfolio: PortfolioSummary };

// Orchestrates state and page routing: "manage" (picker menu) shows <ManageList>, "move" (account
// drawer) shows <MoveList>; create/delete are second-level pages morphed in via viewId.
export function PortfolioPickerModal({
  mode,
  accountId,
  currentPortfolioId,
  open,
  onClose,
}: {
  mode: "manage" | "move";
  accountId?: string; // move mode: the account being moved
  /** Move mode: the portfolio the account currently belongs to (drives the green check). */
  currentPortfolioId?: string;
  open: boolean;
  onClose: () => void;
}) {
  const isDesktop = useMediaQuery("(min-width: 640px)");
  const [view, setView] = useState<View>({ id: "list" });
  const backToList = () => setView({ id: "list" });

  return (
    <Portal>
      <MorphingModal
        viewId={open ? view.id : null}
        // Second-level pages go back to the list; the list closes the modal.
        onClose={view.id === "list" ? onClose : backToList}
        placement={isDesktop ? "center" : "bottom"}
        className="max-w-sm"
      >
        {!open ? null : view.id === "delete" ? (
          <DeletePage portfolio={view.portfolio} onDone={backToList} />
        ) : view.id === "create" ? (
          <CreatePage onDone={backToList} />
        ) : mode === "move" ? (
          <MoveList
            accountId={accountId}
            currentPortfolioId={currentPortfolioId}
            onClose={onClose}
            onCreate={() => setView({ id: "create" })}
          />
        ) : (
          <ManageList
            onClose={onClose}
            onDelete={(portfolio) => setView({ id: "delete", portfolio })}
          />
        )}
      </MorphingModal>
    </Portal>
  );
}

function PickerHeader({ title, onClose }: { title: string; onClose: () => void }) {
  const tc = useTranslations("Common");
  return (
    <div className="flex items-center justify-between gap-2">
      <h2 className="font-semibold text-base">{title}</h2>
      <button
        type="button"
        aria-label={tc("close")}
        className="-mr-1 flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        onClick={onClose}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

function ManageList({
  onClose,
  onDelete,
}: {
  onClose: () => void;
  onDelete: (p: PortfolioSummary) => void;
}) {
  const t = useTranslations("Portfolio");
  const tc = useTranslations("Common");
  const queryClient = useQueryClient();
  const { portfolios } = usePortfolio();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // Only the portfolio domain needs refreshing for rename / set-default.
  const invalidate = () => invalidateFor(queryClient, "portfolio.write");

  const renameMut = useMutation({
    mutationFn: (v: { portfolioId: string; name: string }) => renamePortfolio({ data: v }),
    onSuccess: async () => {
      setRenamingId(null);
      await invalidate();
    },
    onError: () => toast.error(t("manageFailed")),
  });
  const defaultMut = useMutation({
    mutationFn: (portfolioId: string) => setDefaultPortfolio({ data: { portfolioId } }),
    onSuccess: invalidate,
    onError: () => toast.error(t("manageFailed")),
  });

  const items: SwipeableListItem[] = portfolios.map((p) => ({
    id: p.id,
    rightActions: p.isDefault
      ? []
      : [
          {
            id: "default",
            label: t("setDefault"),
            icon: <Pin className="size-4" />,
            tone: "primary",
            onClick: () => defaultMut.mutate(p.id),
          },
          {
            id: "delete",
            label: tc("delete"),
            icon: <Trash2 className="size-4" />,
            tone: "danger",
            onClick: () => onDelete(p),
          },
        ],
    content: (
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="min-w-0 flex-1">
          <EditableName
            value={p.name}
            editing={renamingId === p.id}
            onEditingChange={(e) => setRenamingId(e ? p.id : null)}
            onSave={async (name) => {
              await renameMut.mutateAsync({ portfolioId: p.id, name });
            }}
            displayClassName="font-medium text-sm"
            tooltip={false}
          />
        </div>
        {p.isDefault && (
          <AnimatedBadge size="sm" showIcon={false} className="shrink-0">
            {t("defaultBadge")}
          </AnimatedBadge>
        )}
      </div>
    ),
  }));

  return (
    <div className="flex flex-col gap-3">
      <PickerHeader title={t("manageTitle")} onClose={onClose} />
      <SwipeableList items={items} classNames={swipeClasses} />
    </div>
  );
}

function MoveList({
  accountId,
  currentPortfolioId,
  onClose,
  onCreate,
}: {
  accountId?: string;
  currentPortfolioId?: string;
  onClose: () => void;
  onCreate: () => void;
}) {
  const t = useTranslations("Portfolio");
  const queryClient = useQueryClient();
  const { portfolios } = usePortfolio();
  const [createHover, setCreateHover] = useState(false);

  const assignMut = useMutation({
    mutationFn: (portfolioId: string) =>
      moveAccountToPortfolio({ data: { accountId: accountId ?? "", portfolioId } }),
    onSuccess: async () => {
      onClose();
      // Moving touches two portfolios' totals, trends and membership; the domain prefix covers it all.
      await invalidateFor(queryClient, "portfolio.write");
      toast.success(t("moved"));
    },
    onError: () => toast.error(t("moveFailed")),
  });

  return (
    <div className="flex flex-col gap-3">
      <PickerHeader title={t("moveToTitle")} onClose={onClose} />

      {/* SharedLayoutBg hosts the hover pill; each button's content must be a single flex container
          (it wraps children in a non-flex z-10 div). */}
      <SharedLayoutBg className="gap-0.5" inset={0} pillClassName="rounded-xl bg-muted">
        {portfolios.map((p) => {
          const current = p.id === currentPortfolioId;
          // Not `disabled` for the current item: a disabled button doesn't dispatch mouseenter, so the
          // sliding pill couldn't reach it. Filter on click instead.
          return (
            <button
              key={p.id}
              type="button"
              aria-current={current}
              className={cn(
                "flex min-h-12 w-full items-center rounded-xl px-3 py-2 text-left text-sm transition-colors",
                current && "cursor-default",
              )}
              onClick={() => {
                if (current || assignMut.isPending) return;
                assignMut.mutate(p.id);
              }}
            >
              <span className="flex w-full min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                {current && <Check className="ml-auto size-4 shrink-0 text-pos" />}
              </span>
            </button>
          );
        })}
      </SharedLayoutBg>

      {/* Create entry: AnimatedBadge swaps its label on hover/focus. */}
      <button
        type="button"
        className="self-start rounded-full outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onMouseEnter={() => setCreateHover(true)}
        onMouseLeave={() => setCreateHover(false)}
        onFocus={() => setCreateHover(true)}
        onBlur={() => setCreateHover(false)}
        onClick={onCreate}
      >
        <AnimatedBadge size="sm" icon={<Plus className="size-3" />}>
          {createHover ? t("createBadgeHover") : t("createBadge")}
        </AnimatedBadge>
      </button>
    </div>
  );
}

function CreatePage({ onDone }: { onDone: () => void }) {
  const t = useTranslations("Portfolio");
  const tc = useTranslations("Common");
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");
  const trimmed = newName.trim();

  const createMut = useMutation({
    mutationFn: (name: string) => createPortfolio({ data: { name } }),
    onSuccess: async () => {
      onDone();
      await invalidateFor(queryClient, "portfolio.write");
    },
    onError: () => toast.error(t("manageFailed")),
  });

  return (
    <div className="flex flex-col gap-4">
      <h2 className="font-semibold text-base">{t("createTitle")}</h2>
      <Input
        value={newName}
        onChange={(v) => setNewName(v)}
        placeholder={t("newPortfolioPlaceholder")}
      />
      <div className="flex gap-2">
        <Button
          type="button"
          variant="ghost"
          className="flex-1"
          onClick={onDone}
          disabled={createMut.isPending}
        >
          {tc("cancel")}
        </Button>
        <Button
          type="button"
          className="flex-1"
          onClick={() => createMut.mutate(trimmed)}
          disabled={!trimmed || createMut.isPending}
        >
          {createMut.isPending ? tc("verifying") : tc("create")}
        </Button>
      </div>
    </div>
  );
}

function DeletePage({ portfolio, onDone }: { portfolio: PortfolioSummary; onDone: () => void }) {
  const t = useTranslations("Portfolio");
  const tc = useTranslations("Common");
  const queryClient = useQueryClient();

  const deleteMut = useMutation({
    mutationFn: (portfolioId: string) => deletePortfolio({ data: { portfolioId } }),
    onSuccess: async () => {
      onDone();
      toast.success(t("deleted"));
      // Deleting returns its accounts to the default portfolio, so refresh the whole domain.
      await invalidateFor(queryClient, "portfolio.write");
    },
    onError: () => toast.error(t("manageFailed")),
  });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="font-semibold text-base">{t("deleteTitle")}</h2>
        <p className="mt-1 text-muted-foreground text-sm">
          {t("deleteConfirm", { name: portfolio.name })}
        </p>
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="ghost"
          className="flex-1"
          onClick={onDone}
          disabled={deleteMut.isPending}
        >
          {tc("cancel")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          className="flex-1"
          onClick={() => deleteMut.mutate(portfolio.id)}
          disabled={deleteMut.isPending}
        >
          {deleteMut.isPending ? tc("verifying") : tc("delete")}
        </Button>
      </div>
    </div>
  );
}

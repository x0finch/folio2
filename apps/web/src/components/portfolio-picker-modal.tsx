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

// swipe 行去卡片:item / surface 均用抽屉底色 bg-background,hover:bg-muted 悬停反馈(同账户侧栏代币面板)。
const swipeClasses: SwipeableListClassNames = {
  root: "gap-0",
  item: "rounded-xl bg-background",
  surface:
    "flex min-h-12 items-center rounded-xl border-0 bg-background px-3 py-2 shadow-none transition-colors hover:bg-muted",
  action: "[&>span]:group-hover:bg-muted!",
};

// 当前视图 = 单一状态源:view.id 既是 MorphingModal 的 morph 标识,也是内容路由的判据(下方渲染直接
// switch view.id,不再另算一份)。list 一层按 mode 分 manage/move;delete 二层携带待删除的 portfolio。
type View = { id: "list" } | { id: "create" } | { id: "delete"; portfolio: PortfolioSummary };

// Portfolio 选择器弹窗(ADR 0033)。**只做状态编排 + 页面路由**,每个页面各自独立组件:
//  · mode="manage"(选择器菜单) → 一层 <ManageList>:改名 + 右滑 pin/删除;删除进 <DeletePage> 二层确认。
//  · mode="move"(账户抽屉「移到组合」)→ 一层 <MoveList>:点选即归属;左下角新建入口进 <CreatePage> 二层。
// 一层 ↔ 二层由 MorphingModal 的 viewId 驱动 morph;二层遮罩/Esc 退回列表,一层遮罩/Esc/叉叉关闭弹窗。
export function PortfolioPickerModal({
  mode,
  accountId,
  currentPortfolioId,
  open,
  onClose,
}: {
  mode: "manage" | "move";
  accountId?: string; // move 模式:被归属的账户
  /** move 模式:那个账户此刻归属哪个组合(画绿勾用)。由账户行给 —— 归属随行下发,ADR 0047。 */
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
        // 二层(create/delete)遮罩/Esc → 退回列表;一层 → 关闭弹窗。
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

// 一层列表页页头:标题 + 右上角关闭叉叉(hover 圆形底)。
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

// manage 一层:SwipeableList —— 行内 EditableName 改名,右滑 pin 设默认 + 删除(删除交给父级切二层确认页)。
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
  // 定向刷新替掉整页刷新(#412):改名 / 设默认改的是组合清单与归属,刷组合域这一个前缀就够。
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

// move 一层:点选即把账户归属过去;当前所在项右侧绿勾。左下角「新建组合」入口(交给父级切二层新建页)。
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
      // 移动账户会同时改两个组合的总额、走势与归属 —— 一句域前缀全盖住。
      await invalidateFor(queryClient, "portfolio.write");
      toast.success(t("moved"));
    },
    onError: () => toast.error(t("moveFailed")),
  });

  return (
    <div className="flex flex-col gap-3">
      <PickerHeader title={t("moveToTitle")} onClose={onClose} />

      {/* SharedLayoutBg 承载 hover 高亮(滑动 pill,与选择器菜单一致)。尺寸(min-h-12 / px-3 / rounded-xl)
          对齐 manage 的 SwipeableList surface → 两态 item 一致。每个 <button> 内容须是单个 flex 容器
          (SharedLayoutBg 会把 children 塞进非 flex 的 z-10 div)。 */}
      <SharedLayoutBg className="gap-0.5" inset={0} pillClassName="rounded-xl bg-muted">
        {portfolios.map((p) => {
          const current = p.id === currentPortfolioId;
          // current 项不设 disabled:否则 disabled button 不派发 mouseenter,SharedLayoutBg 的滑动 pill
          // 就到不了它。改为点击时过滤(current / 进行中 → no-op),pill 全程可达。
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

      {/* 左下角新建入口:AnimatedBadge 包裹 —— hover/聚焦切文案(children 变 → badge 内置 text-roll),
          让入口更灵动。点击进二层新建页。 */}
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

// 二层:新建组合名称。建完回列表(新组合随 invalidate 出现,由用户再选)。
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

// 二层:删除确认。删完回列表(账户退回默认组合)。
function DeletePage({ portfolio, onDone }: { portfolio: PortfolioSummary; onDone: () => void }) {
  const t = useTranslations("Portfolio");
  const tc = useTranslations("Common");
  const queryClient = useQueryClient();

  const deleteMut = useMutation({
    mutationFn: (portfolioId: string) => deletePortfolio({ data: { portfolioId } }),
    onSuccess: async () => {
      onDone();
      toast.success(t("deleted"));
      // 删组合会把它的账户退回默认组合 → 默认视图的总额也变,所以刷整个域而不只是清单。
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

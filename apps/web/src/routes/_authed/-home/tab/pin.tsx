import { cn, Skeleton, TabsTrigger, toast } from "@folio/ui";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useTranslations } from "use-intl";
import { QueryBoundary } from "@/components/query-boundary";
import { MAX_PINS_PER_PORTFOLIO } from "@/lib/core/accounts-in-view";
import { connectorLabelFallback } from "@/lib/core/logo";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { accountListQuery } from "@/lib/queries/accounts";
import { connectorCatalogQuery } from "@/lib/queries/connectors";
import { type HomeTabStrip, homeTabStripQuery } from "@/lib/queries/portfolio";
import { invalidateFor } from "@/lib/queries/refresh";
import { tagListQuery } from "@/lib/queries/tags";
import { createTabPin, deleteTabPin, updateTabPinTarget } from "@/lib/server/tab-pins";
import { kindTabsOf, tabAfterUnpin } from "@/routes/_authed/-home/home-tabs";
import { type PinTargetChoice, TabPinPicker } from "./pin-picker";
import { PinPanel } from "./pin-portal-popover";
import { PinTargetMark } from "./pin-target-mark";
import { useHomeTabSelection } from "./selection";

// 单个自定义 pin:本体是**普通 beUI TabsTrigger**(点选原生工作、与视角 tab 共享滑动药丸);
// 管理面板经 PinPanel 浮出。写(改指向 / 取消固定)自包含。
export function PinTab({ pin }: { pin: HomeTabStrip["pins"][number] }) {
  const { selectedId } = usePortfolio();
  const queryClient = useQueryClient();
  const { data: strip } = useSuspenseQuery(homeTabStripQuery(selectedId));
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
    onSuccess: () => invalidateFor(queryClient, "portfolio.pin.write"),
    onError: failPin,
  });
  const unpinMut = useMutation({
    mutationFn: () => deleteTabPin({ data: { pinId: pin.id } }),
    onSuccess: () => invalidateFor(queryClient, "portfolio.pin.write"),
    onError: failPin,
  });
  const onUnpin = () => {
    if (shownActive === pin.id) {
      // 取消当前激活的 → 回**左邻**:前一个 pin,没有则最后一个视角 tab(别一路滑回第一个)。
      selectTab(tabAfterUnpin(pin.id, strip.pins, kindTabsOf(strip.hasPerps, strip.hasDefi)));
    }
    unpinMut.mutate();
  };
  return (
    <PinPanel
      // 必须先选中才可开(需求 9):首点选中(此刻 isActive 仍是旧值 false)不开,再点才开。
      gate={isActive}
      ghost={
        <span
          className={cn(
            "inline-flex h-full w-full items-center justify-center whitespace-nowrap rounded-full px-3.5 font-medium text-sm",
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
          {/* 分割线:把「取消固定」与上面的选择器隔开(独立直线,不挂在带圆角按钮上)。 */}
          <div className="border-border border-t" />
          <button
            type="button"
            onClick={onUnpin}
            disabled={unpinMut.isPending}
            className="rounded-md px-2 py-1.5 text-left text-destructive text-sm transition-colors hover:bg-destructive/10 disabled:opacity-50"
          >
            {tct("unpin")}
          </button>
        </div>
      )}
    >
      <TabsTrigger value={pin.id}>
        {/* 类型标记(#351 ②):tag `#名` / account `@名` / connector `logo + 类型名`。
            激活时药丸是浅底 → onPrimary 让 logo 的底盘随之改色,不叠成两块白。 */}
        <PinTargetMark kind={selected.kind} name={pin.name} logo={pin.logo} onPrimary={isActive} />
      </TabsTrigger>
    </PinPanel>
  );
}

// ＋固定:ghost 加钮(hover 无边框,A1);面板同样经 PinPanel 浮出。写自包含。
export function AddPinButton() {
  const { selectedId } = usePortfolio();
  const queryClient = useQueryClient();
  const { data: strip } = useSuspenseQuery(homeTabStripQuery(selectedId));
  const { selectTab } = useHomeTabSelection(strip.pins);
  const tct = useTranslations("CustomTabs");
  const addMut = useMutation({
    // 带上当前组合:上限按组合算,而 pin 行上没有这个字段(ADR 0047)。
    mutationFn: (choice: PinTargetChoice) =>
      createTabPin({ data: { ...choice, portfolioId: selectedId } }),
    onSuccess: async (pin) => {
      // 先等 tab 条刷新、新 tab 挂上再选中 —— 提前选中会让 active 短暂指向不存在的 tab,
      // 被 clamp 回 tokens,药丸先滑到第一个再滑回来(实测)。
      await invalidateFor(queryClient, "portfolio.pin.write");
      selectTab(pin.id);
    },
    onError: () => toast.error(tct("actionFailed")),
  });
  // 满员不渲染。`pins.length` 是刷新前的清单,所以在飞期间 ＋ 还在;
  // 不禁的话手快能再挑一个。**真正兜住上限的是数据库那道**
  // (`packages/db/src/queries/tab-pins.ts` 的 `MAX_TAB_PINS_PER_USER`,超了直接拒),这里挡的
  // 只是「让用户白挑一次、再吃一个报错」。
  if (strip.pins.length >= MAX_PINS_PER_PORTFOLIO) return null;
  return (
    <PinPanel
      disabled={addMut.isPending}
      ghost={<Plus className="size-4 text-muted-foreground" />}
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
        <Plus className="size-4" />
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

// 选择器打开才拉目录 / 账户 / 标签 —— 这三份退出首屏关键路径。PinPanel 关着时不挂 children,
// 所以这里的查询不会在 tab 条一出现就飞。
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
  // **三类选项都只来自当前组合**(ADR 0047):这两份数据由服务端按组合筛过了,所以这里不再有
  // 「客户端按归属 / 按 portfolioId 再筛一遍」那一步。**connector 那类以前是漏的** ——
  // 它取的是全量账户的 connector 集合,于是能在一个组合里 pin 一个它压根没有的 connector。
  const { selectedId } = usePortfolio();
  const { data: catalog } = useSuspenseQuery(connectorCatalogQuery());
  const { data: accounts } = useSuspenseQuery(accountListQuery(selectedId));
  const { data: tags } = useSuspenseQuery(tagListQuery(selectedId));
  // 归档账户不给 pin:pin 是「常看的一个视角」,而归档是封存(ADR 0039)。
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

import {
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  TabsTrigger,
  toast,
  useMediaQuery,
} from "@folio/ui";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { Portal } from "../../../../components/portal";
import { QueryBoundary } from "../../../../components/query-boundary";
import { accountsInView } from "../../../../lib/accounts-in-view";
import { connectorLabelFallback } from "../../../../lib/connector-label";
import { kindTabsOf, tabAfterUnpin } from "../../../../lib/home-tabs";
import { usePortfolio } from "../../../../lib/hooks/use-portfolio";
import { accountListQuery } from "../../../../lib/queries/accounts";
import { connectorCatalogQuery } from "../../../../lib/queries/connectors";
import {
  type HomeTabStrip,
  homeTabStripQuery,
  portfolioMembershipsQuery,
} from "../../../../lib/queries/portfolio";
import { invalidateFor } from "../../../../lib/queries/refresh";
import { tagListQuery } from "../../../../lib/queries/tags";
import { createTabPin, deleteTabPin, updateTabPinTarget } from "../../../../lib/server/tab-pins";
import { type PinTargetChoice, TabPinPicker } from "./pin-picker";
import { PinTargetMark } from "./pin-target-mark";
import { revealTab, useHomeTabSelection } from "./selection";

const MAX_PINS = 3;

const PIN_PANEL_W = 240; // w-56 + p-2
const PIN_PANEL_H = 340; // 面板大致高度,够不够放得下决定朝上还是朝下
const GOO_COLLAPSE_MS = 400; // beUI goo 收拢 spring 视觉时长 ~0.32s,放完再卸载浮层

// pin/＋ 的管理面板:**整个 beUI Popover 连带渲染进 Portal**(goo 动效原样保留),fixed 覆在触发器位置、
// z 高于 hero —— 既不被横向滚动容器裁(overflow-x:auto 会连带裁纵向),也不被 hero 盖住,更不会撑出页面
// 横向滚动条(fixed 不参与文档滚动)。触发器渲染 ghost(真 tab 的视觉拷贝,像素重合)且**必须有真实尺寸**
//(Popover 根 h-full w-full 撑满 fixed 盒子,否则量出 0×0 → goo 裁剪从零矩形起步,面板被自己裁没)。
// 关闭态整层不吃指针,点击照常落到底下真正的 tab;打开态点触发器区域由 beUI 自身的 click-toggle 关闭
//(面板内点击不会误触关闭)。
function PinPortalPopover({
  open,
  rect,
  ghost,
  onRequestClose,
  onMouseEnter,
  onMouseLeave,
  children,
}: {
  open: boolean;
  rect: DOMRect | null;
  ghost: ReactNode; // 触发器的视觉拷贝:与底下真 tab 像素重合,让 goo 药丸回到「文字底下」(原生层叠)
  onRequestClose: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  children: ReactNode;
}) {
  // 挂载/翻开分两拍走,卸载等收拢放完:
  // ① beUI Popover **首帧就带 open=true 挂载**会踩内部竞态(量尺寸的 re-render 与开场 spring 抢跑,
  //    裁剪停在 p=0、面板隐形,实测)→ 先挂载(关)、下一拍再翻开,恒走页面上其它 popover 的健康路径。
  // ② 关闭后 goo 底色在触发器位置留一块药丸 —— 原生 beUI 里它垫在触发器**底下**,portal 后整层浮在
  //    tab **上面**,不卸载就永久盖住 tab(实测)→ 收拢动画放完(GOO_COLLAPSE_MS)整个卸载。
  const [mounted, setMounted] = useState(false);
  const [openDeferred, setOpenDeferred] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    setOpenDeferred(false);
    const t = setTimeout(() => setMounted(false), GOO_COLLAPSE_MS);
    return () => clearTimeout(t);
  }, [open]);
  useEffect(() => {
    if (open && mounted) setOpenDeferred(true);
  }, [open, mounted]);
  if (!rect || !mounted) return null;
  // 横向:右边放得下就左对齐触发器,否则右对齐;竖向:下方放得下就朝下,否则朝上。皆按**视口**算(已 fixed)。
  const align: "start" | "end" = rect.left + PIN_PANEL_W <= window.innerWidth - 8 ? "start" : "end";
  const side: "top" | "bottom" =
    window.innerHeight - rect.bottom > PIN_PANEL_H || rect.top < PIN_PANEL_H ? "bottom" : "top";
  return (
    <Portal>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 纯浮层容器;可交互项在面板内,tab 本身可键盘达。 */}
      <div
        style={{
          position: "fixed",
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          zIndex: 60,
          pointerEvents: open ? "auto" : "none", // 关闭态不挡底下的 tab 点击
        }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        <Popover
          open={openDeferred}
          trigger="click"
          side={side}
          align={align}
          // 16 = tab 药丸 rounded-full 的半径(高 32 的一半):beUI 的 goo 触发药丸半径取
          // min(tH/2, panelRadius),给 16 才与 ghost/真 tab 圆角完全重合,不然深色角会露出来。
          panelRadius={16}
          onOpenChange={(next) => {
            if (!next) onRequestClose(); // beUI 的点外部/Esc/点触发器关闭,统一回流到调用方
          }}
          // h-full w-full:让根撑满 fixed 盒子 → 触发器量出真实尺寸(0×0 会毁掉 goo 几何)。
          className="h-full w-full"
        >
          <PopoverTrigger>
            {/* ghost 在 goo 层(z-[-1])之上 —— 复刻原生 beUI 的层叠:药丸在触发器底下,动画全程不遮字。 */}
            <span className="flex h-full w-full items-center justify-center">{ghost}</span>
          </PopoverTrigger>
          <PopoverContent className="p-2">{children}</PopoverContent>
        </Popover>
      </div>
    </Portal>
  );
}

// 开合行为(需求 9:桌面/手机一致):gateOpen 不过就**绝不开** —— pin 必须先选中(首点只选中,
// 再点已选中的才开);＋ 无「选中」一说,首次触发即开。桌面额外有 hover:已选中的 pin 移上去即开、
// 移开延迟一点再关(便于从 tab 挪进面板);未选中的 hover 不开。滚动/缩放即关,避免 fixed 浮层与触发器脱节。
function usePinPanel(canHover: boolean, gateOpen: () => boolean) {
  const anchorRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const show = () => {
    clear();
    const a = anchorRef.current;
    if (a) revealTab(a); // 半裁的触发器先滚进可视区再量位 —— 否则 fixed 浮层会按未裁坐标悬到合计上
    const r = a?.getBoundingClientRect();
    if (r) setRect(r);
    setOpen(true);
  };
  const close = () => {
    clear();
    setOpen(false);
  };
  const hideSoon = () => {
    clear();
    timer.current = setTimeout(() => setOpen(false), 140);
  };
  // 浮层是 fixed 的:触发器一移位就与面板脱节 → 关掉。两道过滤,只关「真脱节」:
  // ① 滚动的容器不包含触发器(= 面板内部滚动,选择器 overflow-y-auto)→ 不关;
  // ② 触发器量出来没动(show() 里 revealTab 自滚的 scroll 事件是异步到的,不算脱节)→ 不关。
  // resize 一律关。
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && anchorRef.current && !t.contains(anchorRef.current)) return;
      const r = anchorRef.current?.getBoundingClientRect();
      if (r && rect && Math.abs(r.left - rect.left) < 1 && Math.abs(r.top - rect.top) < 1) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, rect]);
  const hoverProps = canHover
    ? {
        onMouseEnter: () => {
          if (gateOpen()) show(); // 未选中的 pin hover 不开(需求 9)
        },
        onMouseLeave: hideSoon,
      }
    : {};
  const onClick = () => {
    if (open) close();
    else if (gateOpen()) show(); // 首点选中时 isActive 还是旧值 false → 只选中不开;再点才开
  };
  return { anchorRef, open, rect, show, close, hideSoon, clear, hoverProps, onClick };
}

// 单个自定义 pin:本体是**普通 beUI TabsTrigger**(点选原生工作、与视角 tab 共享滑动药丸);
// 管理面板经 PinPortalPopover 浮出(改指向选择器 / 取消固定)。写(改指向 / 取消固定)自包含。
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
  const canHover = useMediaQuery("(hover: hover)");
  // 桌面/触屏一致(需求 9):必须先选中才可开面板 —— 首点选中(此刻 isActive 仍是旧值 false)不开,
  // 再点已选中的才开;桌面上已选中的 hover 也开。
  const p = usePinPanel(canHover, () => isActive);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 内层 TabsTrigger 才是可键盘达的交互元素;此层只承 hover/tap 揭示面板。
    // biome-ignore lint/a11y/useKeyWithClickEvents: 同上 —— 选中/面板项均可键盘达,此层只是触屏 tap 的包装。
    <span
      ref={p.anchorRef as RefObject<HTMLSpanElement>}
      className="inline-flex"
      onClick={p.onClick}
      {...p.hoverProps}
    >
      <TabsTrigger value={pin.id}>
        {/* 类型标记(#351 ②):tag `#名` / account `@名` / connector `logo + 类型名`。
            激活时药丸是浅底 → onPrimary 让 logo 的底盘随之改色,不叠成两块白。 */}
        <PinTargetMark kind={selected.kind} name={pin.name} logo={pin.logo} onPrimary={isActive} />
      </TabsTrigger>
      <PinPortalPopover
        open={p.open}
        rect={p.rect}
        // 视觉拷贝随 isActive 走:面板只在选中时开(白药丸),但关闭动画期间可能已切走(还原成灰字)。
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
        onRequestClose={p.close}
        onMouseEnter={canHover ? p.clear : undefined}
        onMouseLeave={canHover ? p.hideSoon : undefined}
      >
        <div className="flex w-56 flex-col gap-2">
          <LazyPinPicker
            selected={selected}
            onPick={(choice) => {
              repointMut.mutate(choice);
              p.close();
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
      </PinPortalPopover>
    </span>
  );
}

// ＋固定:ghost 加钮(hover 无边框,A1);面板同样浮出 —— 桌面 hover、触屏首点即开。写自包含。
export function AddPinButton() {
  const { selectedId } = usePortfolio();
  const queryClient = useQueryClient();
  const { data: strip } = useSuspenseQuery(homeTabStripQuery(selectedId));
  const { selectTab } = useHomeTabSelection(strip.pins);
  const tct = useTranslations("CustomTabs");
  const addMut = useMutation({
    mutationFn: (choice: PinTargetChoice) => createTabPin({ data: choice }),
    onSuccess: async (pin) => {
      // 先等 tab 条刷新、新 tab 挂上再选中 —— 提前选中会让 active 短暂指向不存在的 tab,
      // 被 clamp 回 tokens,药丸先滑到第一个再滑回来(实测)。
      await invalidateFor(queryClient, "portfolio.pin.write");
      selectTab(pin.id);
    },
    onError: () => toast.error(tct("actionFailed")),
  });
  const canHover = useMediaQuery("(hover: hover)");
  const p = usePinPanel(canHover, () => true); // ＋ 只有「开面板」一个动作
  // 满员不渲染。`pins.length` 是刷新前的清单,所以在飞期间 ＋ 还在;
  // 不禁的话手快能再挑一个。**真正兜住上限的是数据库那道**
  // (`packages/db/src/queries/tab-pins.ts` 的 `MAX_TAB_PINS_PER_USER`,超了直接拒),这里挡的
  // 只是「让用户白挑一次、再吃一个报错」。
  //
  // `disabled` 就够,不用再去 gate `usePinPanel`:hover 开面板的监听虽然挂在外层 `<span>` 上,
  // 但 Chrome 不会从 disabled 的表单控件派发鼠标事件,那个 mouseover 压根到不了 React(实测)。
  if (strip.pins.length >= MAX_PINS) return null;
  return (
    <span ref={p.anchorRef as RefObject<HTMLSpanElement>} className="inline-flex" {...p.hoverProps}>
      <button
        type="button"
        aria-label={tct("add")}
        onClick={p.onClick}
        disabled={addMut.isPending}
        className="flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        <Plus className="size-4" />
      </button>
      <PinPortalPopover
        open={p.open}
        rect={p.rect}
        ghost={<Plus className="size-4 text-muted-foreground" />}
        onRequestClose={p.close}
        onMouseEnter={canHover ? p.clear : undefined}
        onMouseLeave={canHover ? p.hideSoon : undefined}
      >
        <div className="w-56">
          <LazyPinPicker
            onPick={(choice) => {
              addMut.mutate(choice);
              p.close();
            }}
          />
        </div>
      </PinPortalPopover>
    </span>
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

// 选择器打开才拉目录 / 账户 / 标签 —— 这三份退出首屏关键路径。PinPortalPopover 关着时不挂 children,
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
  const { selectedId, defaultId } = usePortfolio();
  const { data: catalog } = useSuspenseQuery(connectorCatalogQuery());
  const { data: allAccounts } = useSuspenseQuery(accountListQuery());
  const { data: tags } = useSuspenseQuery(tagListQuery());
  const { data: memberships } = useSuspenseQuery(portfolioMembershipsQuery());
  const connectorOptions = [...new Set(allAccounts.map((a) => a.connectorId))].map((id) => ({
    id,
    label: catalog[id]?.label ?? connectorLabelFallback(id),
  }));
  const tagOptions = tags
    .filter((tg) => tg.portfolioId === selectedId)
    .map((tg) => ({ id: tg.id, name: tg.name }));
  const accountOptions = accountsInView(allAccounts, memberships, selectedId, defaultId).map(
    (a) => ({ id: a.id, label: a.label }),
  );
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

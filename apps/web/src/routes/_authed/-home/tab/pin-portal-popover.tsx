import { Popover, PopoverContent, PopoverTrigger, useMediaQuery } from "@folio/ui";
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { Portal } from "@/components/portal";
import { revealTab } from "./selection";

const PIN_PANEL_W = 240; // w-56 + p-2
const PIN_PANEL_H = 340; // 面板大致高度,够不够放得下决定朝上还是朝下
const VIEW_INSET = 8;
const GOO_COLLAPSE_MS = 400; // beUI goo 收拢 spring 视觉时长 ~0.32s,放完再卸载浮层
const HIDE_SOON_MS = 140;

// 挂载/翻开分两拍,卸载等收拢放完:
// ① beUI Popover **首帧就带 open=true 挂载**会踩内部竞态(量尺寸的 re-render 与开场 spring 抢跑,
//    裁剪停在 p=0、面板隐形,实测)→ 先挂载(关)、下一拍再翻开,恒走页面上其它 popover 的健康路径。
// ② 关闭后 goo 底色在触发器位置留一块药丸 —— 原生 beUI 里它垫在触发器**底下**,portal 后整层浮在
//    tab **上面**,不卸载就永久盖住 tab(实测)→ 收拢动画放完整个卸载。
function useDeferredOpen(open: boolean) {
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
  return { mounted, openDeferred };
}

// 横向:右边放得下就左对齐触发器,否则右对齐;竖向:下方放得下就朝下,否则朝上。按视口算(浮层已 fixed)。
function placePanel(
  rect: DOMRect,
  view: { width: number; height: number },
): { align: "start" | "end"; side: "top" | "bottom" } {
  return {
    align: rect.left + PIN_PANEL_W <= view.width - VIEW_INSET ? "start" : "end",
    side: view.height - rect.bottom > PIN_PANEL_H || rect.top < PIN_PANEL_H ? "bottom" : "top",
  };
}

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
  const { mounted, openDeferred } = useDeferredOpen(open);
  if (!rect || !mounted) return null;
  const { align, side } = placePanel(rect, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
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

function useHoverDelay(onHide: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onHideRef = useRef(onHide);
  onHideRef.current = onHide;
  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  useEffect(() => () => clear(), [clear]);
  const hideSoon = useCallback(() => {
    clear();
    timer.current = setTimeout(() => onHideRef.current(), HIDE_SOON_MS);
  }, [clear]);
  return { clear, hideSoon };
}

// 浮层是 fixed 的:触发器一移位就与面板脱节 → 关掉。两道过滤,只关「真脱节」:
// ① 滚动的容器不包含触发器(= 面板内部滚动,选择器 overflow-y-auto)→ 不关;
// ② 触发器量出来没动(show() 里 revealTab 自滚的 scroll 事件是异步到的,不算脱节)→ 不关。
// resize 一律关。
function useCloseOnDetach(
  open: boolean,
  rect: DOMRect | null,
  anchorRef: RefObject<HTMLElement | null>,
  close: () => void,
) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && anchorRef.current && !t.contains(anchorRef.current)) return;
      const r = anchorRef.current?.getBoundingClientRect();
      if (r && rect && Math.abs(r.left - rect.left) < 1 && Math.abs(r.top - rect.top) < 1) return;
      closeRef.current();
    };
    const onResize = () => closeRef.current();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, rect, anchorRef]);
}

// 开合行为(需求 9:桌面/手机一致):gateOpen 不过就**绝不开** —— pin 必须先选中(首点只选中,
// 再点已选中的才开);＋ 无「选中」一说,首次触发即开。桌面额外有 hover:已选中的 pin 移上去即开、
// 移开延迟一点再关(便于从 tab 挪进面板);未选中的 hover 不开。
function usePinPanel(canHover: boolean, gateOpen: () => boolean) {
  const anchorRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const { clear, hideSoon } = useHoverDelay(close);
  const closeNow = useCallback(() => {
    clear();
    close();
  }, [clear, close]);
  useCloseOnDetach(open, rect, anchorRef, closeNow);

  const show = () => {
    clear();
    const a = anchorRef.current;
    if (a) revealTab(a); // 半裁的触发器先滚进可视区再量位 —— 否则 fixed 浮层会按未裁坐标悬到合计上
    const r = a?.getBoundingClientRect();
    if (r) setRect(r);
    setOpen(true);
  };
  const hoverProps = canHover
    ? {
        onMouseEnter: () => {
          if (gateOpen()) show(); // 未选中的 pin hover 不开(需求 9)
        },
        onMouseLeave: hideSoon,
      }
    : {};
  const onClick = () => {
    if (open) closeNow();
    else if (gateOpen()) show(); // 首点选中时 isActive 还是旧值 false → 只选中不开;再点才开
  };
  return { anchorRef, open, rect, close: closeNow, hideSoon, clear, hoverProps, onClick };
}

// 对外唯一入口:包住触发器,自己管锚点 / hover / 开合 / ghost / 浮层。
// gate 不过就绝不开(pin 必须先选中;＋ 不传,默认开)。disabled 时 hover/点击都不开。
export function PinPanel({
  gate = true,
  disabled = false,
  ghost,
  children,
  panel,
}: {
  gate?: boolean;
  disabled?: boolean;
  ghost: ReactNode;
  children: ReactNode;
  panel: (close: () => void) => ReactNode;
}) {
  const canHover = useMediaQuery("(hover: hover)");
  const p = usePinPanel(canHover, () => !disabled && gate);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 内层触发器才是可键盘达的交互元素;此层只承 hover/tap 揭示面板。
    // biome-ignore lint/a11y/useKeyWithClickEvents: 同上 —— 选中/面板项均可键盘达,此层只是触屏 tap 的包装。
    <span
      ref={p.anchorRef as RefObject<HTMLSpanElement>}
      className="inline-flex"
      onClick={p.onClick}
      {...p.hoverProps}
    >
      {children}
      <PinPortalPopover
        open={p.open}
        rect={p.rect}
        ghost={ghost}
        onRequestClose={p.close}
        onMouseEnter={canHover ? p.clear : undefined}
        onMouseLeave={canHover ? p.hideSoon : undefined}
      >
        {panel(p.close)}
      </PinPortalPopover>
    </span>
  );
}

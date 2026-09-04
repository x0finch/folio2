import { createFileRoute } from "@tanstack/react-router";
import { lazy, useState } from "react";
import { PageSwitcher, type SwitcherPage } from "@/components/page-switcher";

// 一次性 spike(FOL-79):拿 PageSwitcher 套假页,在真机 iOS 上验"Activity 保活 + 每页自带骨架 + lazy 首次加载"。
// **公开路由 `/spike`,不碰真 App;验完连同假页一起删(FOL-81)。** PageSwitcher 本身是产品代码,留下。
export const Route = createFileRoute("/spike")({
  ssr: false,
  component: Spike,
});

const DEFS = [
  { key: "overview", label: "总览", bg: "#e0f2fe", fg: "#0369a1" },
  { key: "accounts", label: "账户", bg: "#dcfce7", fg: "#15803d" },
  { key: "insights", label: "洞察", bg: "#fef9c3", fg: "#a16207" },
  { key: "settings", label: "设置", bg: "#fae8ff", fg: "#a21caf" },
] as const;
type Def = (typeof DEFS)[number];

// once:让 prefetch 的调用和 React.lazy 内部的调用共享同一个 promise。
// 不加的话两边各调一次 factory → 两个定时器 / 两条 promise,预热就白费了。
function once<T>(fn: () => Promise<T>) {
  let p: Promise<T> | undefined;
  return () => {
    p ??= fn();
    return p;
  };
}

// 每页:lazy 组件 + 自带骨架 + 一个 prefetch(预热 chunk)。真实里 `load` 就是 `() => import("./pages/xxx")`。
const PAGES: (SwitcherPage & { def: Def; prefetch: () => void })[] = DEFS.map((d) => {
  // 模拟"chunk 首次加载 ~900ms"。这期间由该页自己的骨架顶着;到了 Suspense 原地换成真页,之后 React 缓存、秒回。
  const load = once(
    () =>
      new Promise<{ default: () => React.JSX.Element }>((res) =>
        setTimeout(() => res({ default: () => <DummyPage def={d} /> }), 900),
      ),
  );
  return {
    key: d.key,
    Component: lazy(load),
    Skeleton: () => <PageSkeleton def={d} />,
    prefetch: load,
    def: d,
  };
});

function Spike() {
  const [active, setActive] = useState("overview");
  return (
    <div style={{ minHeight: "100svh", background: "#fff", fontFamily: "system-ui" }}>
      <div style={{ paddingBottom: 96 }}>
        <PageSwitcher pages={PAGES} activeKey={active} />
      </div>

      {/* 底部导航(模拟 Dock)。 */}
      <nav
        style={{
          position: "fixed",
          bottom: "calc(16px + env(safe-area-inset-bottom))",
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          gap: 8,
          padding: 8,
          borderRadius: 999,
          background: "rgba(0,0,0,0.85)",
          zIndex: 40,
        }}
      >
        {PAGES.map((p) => (
          <button
            key={p.key}
            type="button"
            // 按下即预热该页 chunk —— 比 click 抢一拍;第一次点新页时骨架更短甚至不出现。
            onPointerDown={() => p.prefetch()}
            onClick={() => setActive(p.key)}
            style={{
              border: "none",
              borderRadius: 999,
              padding: "10px 16px",
              fontSize: 14,
              color: p.key === active ? "#111" : "#fff",
              background: p.key === active ? "#fff" : "transparent",
              cursor: "pointer",
            }}
          >
            {p.def.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

const ROW_SLOTS = Array.from({ length: 12 }, (_, i) => `r${i + 1}`);

// 每页自己的骨架:用该页的语义色浅浅染一下 + 角标写清是哪个 tab —— 在真机上一眼看出"是这个 tab 自己的骨架"。
function PageSkeleton({ def }: { def: Def }) {
  return (
    <div style={{ position: "relative", minHeight: "100svh", padding: 24, background: def.bg }}>
      <div
        style={{
          position: "absolute",
          top: 24,
          right: 16,
          padding: "6px 12px",
          borderRadius: 999,
          background: `${def.fg}1a`,
          color: def.fg,
          fontSize: 13,
        }}
      >
        「{def.label}」骨架
      </div>
      <div style={{ height: 40, width: 140, borderRadius: 10, background: `${def.fg}26` }} />
      <div
        style={{ marginTop: 8, height: 16, width: 90, borderRadius: 8, background: `${def.fg}1f` }}
      />
      {ROW_SLOTS.map((slot) => (
        <div
          key={`sk-${def.key}-${slot}`}
          style={{ marginTop: 12, height: 64, borderRadius: 12, background: `${def.fg}17` }}
        />
      ))}
    </div>
  );
}

function DummyPage({ def }: { def: Def }) {
  return (
    <div style={{ position: "relative", background: def.bg, minHeight: "100svh", padding: 24 }}>
      {/* 假 HeaderSync:absolute 定位到右上,验证切换时不跳。 */}
      <div
        style={{
          position: "absolute",
          top: 24,
          right: 16,
          padding: "6px 12px",
          borderRadius: 999,
          background: "rgba(0,0,0,0.08)",
          fontSize: 13,
        }}
      >
        同步 · 3 源
      </div>
      <h1 style={{ color: def.fg, fontSize: 40, margin: "8px 0 4px" }}>{def.label}</h1>
      <p style={{ color: def.fg, opacity: 0.7, margin: 0 }}>{def.key}</p>
      {/* 保活证据:打字,切走再回来,字还在。 */}
      <input
        placeholder={`在「${def.label}」打点字,切走再回看还在不在`}
        style={{
          marginTop: 20,
          width: "100%",
          maxWidth: 360,
          padding: "10px 12px",
          borderRadius: 10,
          border: `1px solid ${def.fg}33`,
          fontSize: 15,
        }}
      />
      {ROW_SLOTS.map((slot, i) => (
        <div
          key={`${def.key}-${slot}`}
          style={{
            marginTop: 12,
            height: 64,
            borderRadius: 12,
            background: "rgba(255,255,255,0.6)",
            display: "flex",
            alignItems: "center",
            padding: "0 16px",
            color: def.fg,
          }}
        >
          {def.label} · 行 {i + 1}
        </div>
      ))}
    </div>
  );
}

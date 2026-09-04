import { createFileRoute } from "@tanstack/react-router";
import { lazy, useState } from "react";
import { PageSwitcher, type SwitcherPage } from "@/components/page-switcher";

// 一次性 spike(FOL-79):拿 PageSwitcher 套假页,在真机 iOS 上验"保活 + 交叉淡入 + 异步不闪"。
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

// 模拟"这一页 chunk + 数据要异步加载":按 key 缓存 → 首次 ~400ms、再进秒回(= 真实的 lazy import + 预取缓存)。
const readyCache = new Map<string, Promise<void>>();
function ready(key: string): Promise<void> {
  let p = readyCache.get(key);
  if (!p) {
    p = new Promise((res) => setTimeout(res, 400));
    readyCache.set(key, p);
  }
  return p;
}

const PAGES: SwitcherPage[] = DEFS.map((d) => ({
  key: d.key,
  ready: () => ready(d.key),
  // React.lazy + 定时器模拟 chunk 加载;首次慢,之后 React 自己缓存组件。
  Component: lazy(
    () =>
      new Promise<{ default: () => React.JSX.Element }>((res) =>
        setTimeout(() => res({ default: () => <DummyPage def={d} /> }), 400),
      ),
  ),
}));

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
        {DEFS.map((d) => (
          <button
            key={d.key}
            type="button"
            onClick={() => setActive(d.key)}
            style={{
              border: "none",
              borderRadius: 999,
              padding: "10px 16px",
              fontSize: 14,
              color: d.key === active ? "#111" : "#fff",
              background: d.key === active ? "#fff" : "transparent",
              cursor: "pointer",
            }}
          >
            {d.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

const ROW_SLOTS = Array.from({ length: 12 }, (_, i) => `r${i + 1}`);

function DummyPage({ def }: { def: (typeof DEFS)[number] }) {
  return (
    <div style={{ position: "relative", background: def.bg, minHeight: "100svh", padding: 24 }}>
      {/* 假 HeaderSync:absolute 定位到右上,验证交叉淡入时不跳。 */}
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

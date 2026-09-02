import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  appCssLoaderScript,
  PWA_LINKS,
  PWA_META,
  SPLASH_STYLE,
  THEME_COLORS,
  VIEWPORT,
} from "@/routes/-root/pwa-head";
import { SPLASH_LOGO_SIZE } from "@/routes/-root/splash-lifecycle";

// 测试缝②③(见 ADR 0027):PWA 只有 manifest 形状 + head 标签能便宜地自动化;
// installability / 安全区 / 更新流靠 Lighthouse + 真机 + 目视。
// 守住 issue 点名的两处回归:manifest 曾是 TanStack 样板、head 曾根本没引 manifest。

const manifest = JSON.parse(
  readFileSync(new URL("../public/manifest.json", import.meta.url), "utf-8"),
) as Record<string, unknown>;

describe("PWA manifest", () => {
  it("换成真 Folio(不再是 TanStack 样板)", () => {
    expect(manifest.name).toBe("Folio");
    expect(manifest.short_name).toBe("Folio");
    expect(String(manifest.name)).not.toContain("TanStack");
  });

  it("含可安装必填字段", () => {
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(typeof manifest.theme_color).toBe("string");
    expect(typeof manifest.background_color).toBe("string");
  });

  it("图标含 192、512(any)与一张 maskable", () => {
    const icons = manifest.icons as { sizes: string; purpose?: string }[];
    expect(icons.some((i) => i.sizes === "192x192")).toBe(true);
    expect(icons.some((i) => i.sizes === "512x512")).toBe(true);
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
  });
});

describe("PWA head 元素", () => {
  it("links 含 manifest(当前缺这行则浏览器读不到)与 apple-touch-icon", () => {
    expect(PWA_LINKS.some((l) => l.rel === "manifest" && l.href === "/manifest.json")).toBe(true);
    expect(PWA_LINKS.some((l) => l.rel === "apple-touch-icon")).toBe(true);
  });

  it("theme-color 明暗两套(各带 prefers-color-scheme media;静态直渲避 TanStack 按 name 去重)", () => {
    expect(THEME_COLORS).toHaveLength(2);
    expect(THEME_COLORS.some((m) => m.media.includes("light"))).toBe(true);
    expect(THEME_COLORS.some((m) => m.media.includes("dark"))).toBe(true);
  });

  it("含 apple-mobile-web-app 标签(独立窗口 + 标题)", () => {
    expect(PWA_META.some((m) => m.name === "apple-mobile-web-app-capable")).toBe(true);
    expect(
      PWA_META.some((m) => m.name === "apple-mobile-web-app-title" && m.content === "Folio"),
    ).toBe(true);
  });

  it("viewport 含 viewport-fit=cover(安全区地基)", () => {
    expect(VIEWPORT).toContain("viewport-fit=cover");
    expect(VIEWPORT).toContain("width=device-width");
  });
});

// 测试缝④(ADR 0051):守住「不白屏」的机制 —— 闪屏关键样式内联在 head、且 app 样式表非阻塞。
// 肉眼首帧/动画渲染靠真机,这里只断言机制在。
describe("冷启动闪屏 head 机制", () => {
  it("SPLASH_STYLE 是自包含关键样式:覆盖层 + 呼吸 + logo 尺寸 + 退场 + 降级", () => {
    expect(SPLASH_STYLE).toContain("#app-splash");
    expect(SPLASH_STYLE).toContain("@keyframes folio-breathe");
    // logo 尺寸取自共享常量(iOS 启动图同读),别写死
    expect(SPLASH_STYLE).toContain(`${SPLASH_LOGO_SIZE}px`);
    // 放行退场 + reduced-motion 降级都在
    expect(SPLASH_STYLE).toContain('[data-exit="true"]');
    expect(SPLASH_STYLE).toContain("prefers-reduced-motion");
  });

  it("app 样式表走脚本注入(非渲染阻塞),不是 head 里的阻塞 <link>", () => {
    const script = appCssLoaderScript("/assets/app-abc12345.css");
    // 脚本注入的 link 不阻塞首帧;断言它建的是 stylesheet link 且带上了 href
    expect(script).toContain("createElement('link')");
    expect(script).toContain("stylesheet");
    expect(script).toContain("/assets/app-abc12345.css");
  });

  it("PWA_LINKS 不再把 app 样式表当阻塞 stylesheet 挂着", () => {
    expect(PWA_LINKS.every((l) => l.rel !== "stylesheet")).toBe(true);
  });
});

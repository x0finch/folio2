// PWA 的 head 元素:manifest 链接、apple-touch 图标、明暗两套 theme-color、apple-mobile-web-app-*。
// 抽成常量供 __root 注入 + 单测断言(测试缝③:守住 issue 点名「当前缺 manifest link」那处)。
// 颜色取 design token 的 --background:亮 oklch(1 0 0)=#ffffff、暗 oklch(0.145 0 0)≈#0a0a0a
//(手算 OKLab→sRGB:achromatic 线性值 0.145³≈0.00305,落在线性段 ×12.92 → 约 #0a0a0a)。
const THEME_COLOR_LIGHT = "#ffffff";
const THEME_COLOR_DARK = "#0a0a0a";

interface HeadLink {
  rel: string;
  href: string;
}
interface HeadMeta {
  name: string;
  content: string;
  media?: string;
}

export const PWA_LINKS: HeadLink[] = [
  { rel: "manifest", href: "/manifest.json" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
];

export const PWA_META: HeadMeta[] = [
  // 浏览器 UI 底色随系统明暗(单个 <meta> 只能一个值,故用 media 拆两条)。
  { name: "theme-color", media: "(prefers-color-scheme: light)", content: THEME_COLOR_LIGHT },
  { name: "theme-color", media: "(prefers-color-scheme: dark)", content: THEME_COLOR_DARK },
  // 独立窗口 + iOS 沉浸状态栏(black-translucent 让内容延伸到状态栏下,配安全区内边距成原生观感)。
  { name: "apple-mobile-web-app-capable", content: "yes" },
  { name: "mobile-web-app-capable", content: "yes" },
  { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
  { name: "apple-mobile-web-app-title", content: "Folio" },
];

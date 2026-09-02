// PWA 的 head 元素:manifest 链接、apple-touch 图标、明暗两套 theme-color、apple-mobile-web-app-*。
// 抽成常量供 __root 注入 + 单测断言(测试缝③:守住 issue 点名「当前缺 manifest link」那处)。
// 颜色取 design token 的 --background(beUI 官方值):亮 lab(98.84%)≈#fcfcfc、暗 #151515
import { SPLASH_EXIT_MS, SPLASH_LOGO_SIZE } from "./splash-lifecycle";

const THEME_COLOR_LIGHT = "#fcfcfc";
const THEME_COLOR_DARK = "#151515";
// muted-foreground 的镜像(offline.html 同款):阶段小字用它,明暗都够读。
const SPLASH_MUTED = "#868686";

// viewport-fit=cover:让布局铺满到刘海/指示条,安全区再靠 env(safe-area-inset-*) 内边距处理
//(见 app-shell 顶栏/底部导航 + styles.css reset)。
export const VIEWPORT = "width=device-width, initial-scale=1, viewport-fit=cover";

interface HeadLink {
  rel: string;
  href: string;
}
interface HeadMeta {
  name: string;
  content: string;
}

export const PWA_LINKS: HeadLink[] = [
  { rel: "manifest", href: "/manifest.json" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
];

export const PWA_META: HeadMeta[] = [
  // 独立窗口 + iOS 沉浸状态栏(black-translucent 让内容延伸到状态栏下,配安全区内边距成原生观感)。
  { name: "apple-mobile-web-app-capable", content: "yes" },
  { name: "mobile-web-app-capable", content: "yes" },
  { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
  { name: "apple-mobile-web-app-title", content: "Folio" },
];

// 浏览器 UI 底色随系统明暗(单个 <meta> 只能一个值,故用 media 拆两条)。
// **不走 head() 的 meta 数组**:TanStack 按 name 去重,两条同名 theme-color 只会留一条;
// 故在 RootDocument 的 <head> 里作静态 JSX 直渲(React 不按 name 去重),两条都保留。
export const THEME_COLORS: { media: string; content: string }[] = [
  { media: "(prefers-color-scheme: light)", content: THEME_COLOR_LIGHT },
  { media: "(prefers-color-scheme: dark)", content: THEME_COLOR_DARK },
];

// 冷启动闪屏的**关键样式**(ADR 0051)。内联进 `<head>`,一个字节都不依赖 app 样式表 ——
// 这样覆盖层不等 appCss 就能画,装成 PWA 用时首帧即见呼吸 logo、不白屏。底色跟随 `.dark`
// (由 THEME_INIT_SCRIPT 在 hydration 前就设好,见 root-document)。放行由 `data-exit` 触发
// 放大扩散 + 淡出。呼吸从 scale(1)/opacity(1) 起步 —— 即 iOS 启动图里 logo 的静止态,静态→呼吸无缝。
// 时长与 splash-lifecycle 的 SPLASH_EXIT_MS(520ms)对齐。
export const SPLASH_STYLE = `
#app-splash{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;
align-items:center;justify-content:center;gap:1.25rem;
padding:env(safe-area-inset-top) 1.5rem env(safe-area-inset-bottom);
background:${THEME_COLOR_LIGHT};color:${THEME_COLOR_DARK};
font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
:root.dark #app-splash{background:${THEME_COLOR_DARK};color:${THEME_COLOR_LIGHT}}
#folio-splash-logo{width:${SPLASH_LOGO_SIZE}px;height:${SPLASH_LOGO_SIZE}px;color:currentColor;
transform-origin:center;will-change:transform,opacity;
animation:folio-breathe 1.8s ease-in-out infinite}
#folio-splash-msg{margin:0;font-size:.875rem;font-weight:500;line-height:1.4;color:${SPLASH_MUTED};
animation:folio-splash-msg-in .3s cubic-bezier(0.16,1,0.3,1)}
#app-splash[data-exit="true"]{animation:folio-splash-out ${SPLASH_EXIT_MS}ms cubic-bezier(0.16,1,0.3,1) forwards}
#app-splash[data-exit="true"] #folio-splash-logo{animation:folio-splash-burst ${SPLASH_EXIT_MS}ms cubic-bezier(0.16,1,0.3,1) forwards}
@keyframes folio-breathe{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.06);opacity:.72}}
@keyframes folio-splash-burst{from{transform:scale(1);opacity:1}to{transform:scale(8);opacity:0}}
@keyframes folio-splash-out{to{opacity:0}}
@keyframes folio-splash-msg-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
@media (prefers-reduced-motion:reduce){
#folio-splash-logo,#app-splash[data-exit="true"] #folio-splash-logo{animation:none}
#folio-splash-msg{animation:none}
#app-splash[data-exit="true"]{animation:folio-splash-out 160ms linear forwards}}
`;

// 让 app 样式表**非渲染阻塞**(ADR 0051)。用「脚本注入 link」而非 <link>:脚本注入的样式表
// 不阻塞解析/首帧,于是内联的 SPLASH_STYLE 能先画、appCss 落地后再套用。无 JS 时走 <noscript>
// 里的普通 <link> 兜底(见 root-document)。运行于 hydration 前(纯脚本,像 THEME_INIT_SCRIPT)。
export function appCssLoaderScript(href: string): string {
  return `(function(){var l=document.createElement('link');l.rel='stylesheet';l.href=${JSON.stringify(href)};document.head.appendChild(l);})();`;
}

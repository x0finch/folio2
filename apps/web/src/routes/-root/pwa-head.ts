// PWA 的 head 元素:manifest 链接、apple-touch 图标、明暗两套 theme-color、apple-mobile-web-app-*。
// 抽成常量供 __root 注入 + 单测断言(测试缝③:守住 issue 点名「当前缺 manifest link」那处)。
// 颜色取 design token 的 --background(beUI 官方值):亮 lab(98.84%)≈#fcfcfc、暗 #151515
const THEME_COLOR_LIGHT = "#fcfcfc";
const THEME_COLOR_DARK = "#151515";

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

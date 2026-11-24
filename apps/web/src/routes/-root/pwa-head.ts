import {
  SPLASH_COLOR_DARK,
  SPLASH_COLOR_LIGHT,
  SPLASH_EXIT_MS,
  SPLASH_LOGO_SIZE,
} from "./splash-lifecycle";

// offline.html has no JS, so it mirrors these colors by hand.
const THEME_COLOR_LIGHT = SPLASH_COLOR_LIGHT;
const THEME_COLOR_DARK = SPLASH_COLOR_DARK;
// Mirrors muted-foreground (as offline.html does).
const SPLASH_MUTED = "#868686";

// viewport-fit=cover: layout extends under the notch; safe-area insets pad it back.
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
  // black-translucent lets content run under the iOS status bar.
  { name: "apple-mobile-web-app-capable", content: "yes" },
  { name: "mobile-web-app-capable", content: "yes" },
  { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
  { name: "apple-mobile-web-app-title", content: "Folio" },
];

// Rendered as static JSX in RootDocument, not via head(): TanStack dedupes meta by name and would
// drop one of the two theme-color entries.
export const THEME_COLORS: { media: string; content: string }[] = [
  { media: "(prefers-color-scheme: light)", content: THEME_COLOR_LIGHT },
  { media: "(prefers-color-scheme: dark)", content: THEME_COLOR_DARK },
];

// Inlined in <head> so the splash paints before the app stylesheet loads. Can't import JS tokens:
// the easing copies lib/ease's EASE_OUT_CSS and durations match SPLASH_EXIT_MS. The message uses
// a fixed `rem` offset: env(safe-area-inset-bottom) is 0 on the first iOS PWA frame, then jumps.
// No entrance animation: on cold start it reads as a screen flash. Unknown `lang` falls back to en.
export const SPLASH_STYLE = `
html{background:${THEME_COLOR_LIGHT}}
:root.dark{background:${THEME_COLOR_DARK}}
#app-splash{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;
background:${THEME_COLOR_LIGHT};color:${THEME_COLOR_DARK};
font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
:root.dark #app-splash{background:${THEME_COLOR_DARK};color:${THEME_COLOR_LIGHT}}
#folio-splash-logo{width:${SPLASH_LOGO_SIZE}px;height:${SPLASH_LOGO_SIZE}px;color:currentColor;
transform-origin:center;will-change:transform,opacity;animation:folio-breathe 1.8s ease-in-out infinite}
#folio-splash-msg{position:absolute;left:0;right:0;bottom:7rem;margin:0;padding:0 1.5rem;
text-align:center;font-size:.875rem;font-weight:500;line-height:1.4;color:${SPLASH_MUTED}}
#folio-splash-msg>[lang]{display:none}
html:not([lang="zh"]) #folio-splash-msg>[lang="en"],html[lang="zh"] #folio-splash-msg>[lang="zh"]{display:inline}
#app-splash[data-exit="true"]{pointer-events:none;animation:folio-splash-out ${SPLASH_EXIT_MS}ms cubic-bezier(0.16,1,0.3,1) forwards}
#app-splash[data-exit="true"] #folio-splash-logo{animation:folio-splash-burst ${SPLASH_EXIT_MS}ms cubic-bezier(0.16,1,0.3,1) forwards}
@keyframes folio-breathe{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.06);opacity:.72}}
@keyframes folio-splash-burst{from{transform:scale(1);opacity:1}to{transform:scale(8);opacity:0}}
@keyframes folio-splash-out{to{opacity:0}}
@media (prefers-reduced-motion:reduce){
#folio-splash-logo,#app-splash[data-exit="true"] #folio-splash-logo{animation:none}
#app-splash[data-exit="true"]{animation:folio-splash-out 160ms linear forwards}}
`;

// A script-injected stylesheet doesn't block first paint, so the inline splash styles win.
// <noscript> in RootDocument covers the no-JS case.
export function appCssLoaderScript(href: string): string {
  return `(function(){var l=document.createElement('link');l.rel='stylesheet';l.href=${JSON.stringify(href)};document.head.appendChild(l);})();`;
}

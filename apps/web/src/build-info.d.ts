// 构建期由 vite `define` 注入(见 vite.config.ts 的 buildInfo),用于设置页底部展示版本 / commit,便于比对线上跑的是哪份代码。
declare const __APP_VERSION__: string;
declare const __COMMIT_HASH__: string;
declare const __BUILD_TIME__: string;

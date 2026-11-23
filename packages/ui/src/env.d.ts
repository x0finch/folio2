// 上游 beUI 件(tooltip)用 `process.env.NODE_ENV` 做开发期告警:Vite 会静态替换它,
// Workers 侧有 nodejs_compat。这里只给类型,免得为一行告警把 @types/node 拉进 UI 包。
declare const process: { env: { NODE_ENV?: string } };

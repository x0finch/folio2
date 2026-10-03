import { createFileRoute } from "@tanstack/react-router";

// better-auth 的 handler 挂在 /api/auth/*(splat)。GET/POST 均转交。
//
// 全量实例(带 passkey)**按需 import**:路由表里的模块每个冷请求都会求值,静态 import 的话
// passkey 那一大块就跟着落到每个 server fn 的冷启动上。只有真打到 /api/auth 才付这一笔。
// 见 `session/session-auth.ts`。
const handle = async (request: Request) => {
  const { getAuth } = await import("@/lib/server/session/auth");
  return getAuth().handler(request);
};

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => handle(request),
      POST: ({ request }: { request: Request }) => handle(request),
    },
  },
});

import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "@/lib/server/internal/auth";

// better-auth 的 handler 挂在 /api/auth/*(splat)。GET/POST 均转交。
export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => getAuth().handler(request),
      POST: ({ request }: { request: Request }) => getAuth().handler(request),
    },
  },
});

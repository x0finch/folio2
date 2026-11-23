import { createFileRoute } from "@tanstack/react-router";

// Lazy import: route modules are evaluated on every cold request, and the passkey-enabled auth
// instance is heavy, so only /api/auth requests pay for it.
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

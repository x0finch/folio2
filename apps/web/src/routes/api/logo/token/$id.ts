import { createFileRoute } from "@tanstack/react-router";
import { serveLogo } from "@/lib/server/logos/serve";
import { tokenLogo } from "@/lib/server/logos/token";
import { runForUser } from "@/lib/server/runtime";
import { userIdOf } from "@/lib/server/session/route-auth";

export const Route = createFileRoute("/api/logo/token/$id")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { id: string }; request: Request }) => {
        const userId = await userIdOf(request);
        if (!userId) {
          return serveLogo(async () => undefined, "token", params.id, { private: true });
        }
        return runForUser("tokenLogo", userId, tokenLogo(params.id));
      },
    },
  },
});

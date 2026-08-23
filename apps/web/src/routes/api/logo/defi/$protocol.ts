import { createFileRoute } from "@tanstack/react-router";
import { defiLogo } from "@/lib/server/logos/defi";
import { serveLogo } from "@/lib/server/logos/serve";
import { runForUser } from "@/lib/server/runtime";
import { userIdOf } from "@/lib/server/session/route-auth";

export const Route = createFileRoute("/api/logo/defi/$protocol")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { protocol: string }; request: Request }) => {
        const userId = await userIdOf(request);
        if (!userId) {
          return serveLogo(async () => undefined, "defi", params.protocol, { private: true });
        }
        return runForUser(userId, defiLogo(params.protocol));
      },
    },
  },
});

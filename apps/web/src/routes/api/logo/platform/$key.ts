import { createFileRoute } from "@tanstack/react-router";
import { connectorPlatformMeta } from "@/lib/server/connectors/platform";
import { platformLogo } from "@/lib/server/logos/platform";
import { serveLogo } from "@/lib/server/logos/serve";
import { runForUser } from "@/lib/server/runtime";
import { userIdOf } from "@/lib/server/session/route-auth";

export const Route = createFileRoute("/api/logo/platform/$key")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { key: string }; request: Request }) => {
        const cm = connectorPlatformMeta(params.key);
        if (cm) return serveLogo(async () => cm.logo, "platform", params.key);

        const userId = await userIdOf(request);
        if (!userId) {
          return serveLogo(async () => undefined, "platform", params.key, { private: true });
        }
        return runForUser("platformLogo", userId, platformLogo(params.key));
      },
    },
  },
});

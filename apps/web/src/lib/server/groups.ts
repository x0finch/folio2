import { env } from "cloudflare:workers";
import { listGroupsByUser } from "@folio/db";
import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "../require-auth";

export const listMyGroups = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(({ context }) => listGroupsByUser(env, context.userId));

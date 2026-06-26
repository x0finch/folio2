import { env } from "cloudflare:workers";
import { listGroupsByUser } from "@folio/db";
import { authedServerFn } from "./authed";

export const listMyGroups = authedServerFn({ method: "GET" }).handler(({ context }) =>
  listGroupsByUser(env, context.userId),
);

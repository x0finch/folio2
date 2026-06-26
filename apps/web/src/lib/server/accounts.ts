import { env } from "cloudflare:workers";
import { listAccountsByUser } from "@folio/db";
import { authedServerFn } from "./authed";

// 受保护的只读示范:userId 取自 requireAuth 注入的 context,绝不接客户端入参。
export const listMyAccounts = authedServerFn({ method: "GET" }).handler(({ context }) =>
  listAccountsByUser(env, context.userId),
);

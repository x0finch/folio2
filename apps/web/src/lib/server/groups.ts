import { createServerFn } from "@tanstack/react-start";
import { db } from "./internal/db";
import { requireAuth } from "./internal/require-auth";

// 组 + 全部 账户↔组 关联(总览按组聚合 / 账户页勾选用)。
export const listGroups = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const [groups, memberships] = await Promise.all([
      db.listGroupsByUser(context.userId),
      db.listMembershipsByUser(context.userId),
    ]);
    return { groups, memberships };
  });

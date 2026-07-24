import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "../require-auth";
import { db } from "./db";

// 组 + 全部 账户↔组 关联(总览按组聚合 / 账户页勾选用)。
export const getMyGroups = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const [groups, memberships] = await Promise.all([
      db.listGroupsByUser(context.userId),
      db.listMembershipsByUser(context.userId),
    ]);
    return { groups, memberships };
  });

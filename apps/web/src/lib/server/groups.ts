import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
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

const CreateGroupInput = z.object({ name: z.string().trim().min(1, "name is required") });
export const createGroup = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(CreateGroupInput)
  .handler(({ data, context }) => db.createGroup(context.userId, { name: data.name }));

const GroupIdInput = z.object({ groupId: z.string().min(1) });
export const deleteGroup = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(GroupIdInput)
  .handler(({ data, context }) => db.deleteGroup(context.userId, data.groupId));

// 成员增删(db op 受 userId 作用域,越权自然抛错)。
const MembershipInput = z.object({ accountId: z.string().min(1), groupId: z.string().min(1) });
export const addAccountToGroup = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(MembershipInput)
  .handler(({ data, context }) =>
    db.addAccountToGroup(context.userId, data.accountId, data.groupId),
  );

export const removeAccountFromGroup = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(MembershipInput)
  .handler(({ data, context }) =>
    db.removeAccountFromGroup(context.userId, data.accountId, data.groupId),
  );

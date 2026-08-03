import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "./internal/db";
import { requireAuth } from "./internal/require-auth";

// Tag(Portfolio 内软标签,ADR 0034)的 server fn:auth 薄壳 → db 门面(userId 经 ALS 带入)。
// 读端把 Tag 定义与 账户→Tag 关联分别整份返回,展示富化在客户端按 accountId 组装(同 memberships 的做法)。

export const listTags = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(({ context }) => db.listTagsByUser(context.userId));

export const listAccountTags = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(({ context }) => db.listAccountTagsByUser(context.userId));

const CreateTagInput = z.object({
  portfolioId: z.string().min(1),
  name: z.string().trim().min(1, "tag name is required"),
});
export const createTag = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(CreateTagInput)
  .handler(({ data, context }) =>
    db.createTag(context.userId, { portfolioId: data.portfolioId, name: data.name }),
  );

const RenameTagInput = z.object({
  tagId: z.string().min(1),
  name: z.string().trim().min(1, "tag name is required"),
});
export const renameTag = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(RenameTagInput)
  .handler(({ data, context }) => db.renameTag(context.userId, data.tagId, data.name));

const TagIdInput = z.object({ tagId: z.string().min(1) });
export const deleteTag = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(TagIdInput)
  .handler(({ data, context }) => db.deleteTag(context.userId, data.tagId));

const AccountTagInput = z.object({
  accountId: z.string().min(1),
  tagId: z.string().min(1),
});
export const attachTag = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(AccountTagInput)
  .handler(({ data, context }) => db.attachTag(context.userId, data.accountId, data.tagId));

export const detachTag = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(AccountTagInput)
  .handler(({ data, context }) => db.detachTag(context.userId, data.accountId, data.tagId));

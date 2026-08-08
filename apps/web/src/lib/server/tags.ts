import { TagStore } from "@folio/db";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { runStore } from "./internal/oracle";
import { requireAuth } from "./internal/require-auth";

// Tag(Portfolio 内软标签,ADR 0034)的 server fn:auth 薄壳 → per-user 的 `TagStore`(ADR 0037)。
// userId 只出现在 `runStore` 那一处 —— 服务的方法签名里没有它,拿错用户在编译期就发生不了。
// 读端把 Tag 定义与 账户→Tag 关联分别整份返回,展示富化在客户端按 accountId 组装(同 memberships 的做法)。

export const listTags = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(({ context }) => runStore(context.userId, TagStore, (s) => s.list()));

export const listAccountTags = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(({ context }) => runStore(context.userId, TagStore, (s) => s.listAccountLinks()));

const CreateTagInput = z.object({
  portfolioId: z.string().min(1),
  name: z.string().trim().min(1, "tag name is required"),
});
export const createTag = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(CreateTagInput)
  .handler(({ data, context }) =>
    runStore(context.userId, TagStore, (s) =>
      s.create({ portfolioId: data.portfolioId, name: data.name }),
    ),
  );

const RenameTagInput = z.object({
  tagId: z.string().min(1),
  name: z.string().trim().min(1, "tag name is required"),
});
export const renameTag = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(RenameTagInput)
  .handler(({ data, context }) =>
    runStore(context.userId, TagStore, (s) => s.rename(data.tagId, data.name)),
  );

const TagIdInput = z.object({ tagId: z.string().min(1) });
export const deleteTag = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(TagIdInput)
  .handler(({ data, context }) => runStore(context.userId, TagStore, (s) => s.remove(data.tagId)));

const AccountTagInput = z.object({
  accountId: z.string().min(1),
  tagId: z.string().min(1),
});
export const attachTag = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(AccountTagInput)
  .handler(({ data, context }) =>
    runStore(context.userId, TagStore, (s) => s.attach(data.accountId, data.tagId)),
  );

export const detachTag = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(AccountTagInput)
  .handler(({ data, context }) =>
    runStore(context.userId, TagStore, (s) => s.detach(data.accountId, data.tagId)),
  );

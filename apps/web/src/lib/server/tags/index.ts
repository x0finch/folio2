import { createServerFn } from "@tanstack/react-start";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { handleListAccountTags } from "./account-tags";
import { AccountTagInput, handleAttachTag } from "./attach";
import { CreateTagInput, handleCreateTag } from "./create";
import { DeleteTagInput, handleDeleteTag } from "./delete";
import { handleDetachTag } from "./detach";
import { handleListTags } from "./list";
import { handleRenameTag, RenameTagInput } from "./rename";

// Tag(Portfolio 内软标签,ADR 0034)资源面:**只做装配**。
// handler 自己只描述业务(返回 Effect,`yield* Database` 取域操作),「哪个用户 / 怎么装配 /
// 错误怎么映射 / 什么时候变成 Promise」全在 `runEffect` 里(#504 T7)。

export const listTags = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(runEffect(handleListTags));

export const listAccountTags = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(runEffect(handleListAccountTags));

export const createTag = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(CreateTagInput)
  .handler(runEffect(handleCreateTag));

export const renameTag = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(RenameTagInput)
  .handler(runEffect(handleRenameTag));

export const deleteTag = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(DeleteTagInput)
  .handler(runEffect(handleDeleteTag));

export const attachTag = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(AccountTagInput)
  .handler(runEffect(handleAttachTag));

export const detachTag = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(AccountTagInput)
  .handler(runEffect(handleDetachTag));

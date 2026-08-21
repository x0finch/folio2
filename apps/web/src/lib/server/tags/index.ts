import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "../session/require-auth";
import { handleListAccountTags } from "./account-tags";
import { AccountTagInput, handleAttachTag } from "./attach";
import { CreateTagInput, handleCreateTag } from "./create";
import { DeleteTagInput, handleDeleteTag } from "./delete";
import { handleDetachTag } from "./detach";
import { handleListTags } from "./list";
import { handleRenameTag, RenameTagInput } from "./rename";

// Tag(Portfolio 内软标签,ADR 0034)资源面:只做装配 → per-user 的 `TagStore`(ADR 0037)。
// userId 只出现在各 handler 的 `runStore` 那一处 —— 服务的方法签名里没有它,拿错用户在编译期就发生不了。

export const listTags = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(handleListTags);

export const listAccountTags = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(handleListAccountTags);

export const createTag = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(CreateTagInput)
  .handler(handleCreateTag);

export const renameTag = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(RenameTagInput)
  .handler(handleRenameTag);

export const deleteTag = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(DeleteTagInput)
  .handler(handleDeleteTag);

export const attachTag = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(AccountTagInput)
  .handler(handleAttachTag);

export const detachTag = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(AccountTagInput)
  .handler(handleDetachTag);

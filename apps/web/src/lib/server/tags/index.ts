import { createServerFn } from "@tanstack/react-start";
import { PortfolioSelectInput } from "@/lib/server/portfolio/scope";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { handleListAccountTags } from "./account-tags";
import { AccountTagInput, handleAttachTag } from "./attach";
import { CreateTagInput, handleCreateTag } from "./create";
import { DeleteTagInput, handleDeleteTag } from "./delete";
import { handleDetachTag } from "./detach";
import { handleListTags } from "./list";
import { handleRenameTag, RenameTagInput } from "./rename";

export const listTags = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioSelectInput)
  .handler(runEffect(handleListTags));

export const listAccountTags = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioSelectInput)
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

import { createServerFn } from "@tanstack/react-start";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { CreateTabPinInput, handleCreateTabPin } from "./create";
import { DeleteTabPinInput, handleDeleteTabPin } from "./delete";
import { handleUpdateTabPinTarget, UpdateTabPinInput } from "./update-target";

// 首页自定义 Tab(pin,ADR 0034)资源面:只做装配。
// 清单读取已并进 `getHomeTabStrip`(标签服务端解析好),这里只留三处写。
//
// **四行里三件事**:`requireAuth` 认人并把 userId 放进 context、`validator` 校入参、
// `runEffect` 建 per-user 环境把 handler 跑成 Promise。handler 自己只剩「描述业务」那一件。

export const createTabPin = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(CreateTabPinInput)
  .handler(runEffect(handleCreateTabPin));

export const updateTabPinTarget = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(UpdateTabPinInput)
  .handler(runEffect(handleUpdateTabPinTarget));

export const deleteTabPin = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(DeleteTabPinInput)
  .handler(runEffect(handleDeleteTabPin));

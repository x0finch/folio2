import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/server/session/require-auth";
import { handleCreateTabPin, PinTargetInput } from "./create";
import { DeleteTabPinInput, handleDeleteTabPin } from "./delete";
import { handleUpdateTabPinTarget, UpdateTabPinInput } from "./update-target";

// 首页自定义 Tab(pin,ADR 0034)资源面:只做装配 → per-user 的 `TabPinStore`(ADR 0037)。
// 清单读取已并进 `getHomeTabStrip`(标签服务端解析好),这里只留三处写。

export const createTabPin = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(PinTargetInput)
  .handler(handleCreateTabPin);

export const updateTabPinTarget = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(UpdateTabPinInput)
  .handler(handleUpdateTabPinTarget);

export const deleteTabPin = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(DeleteTabPinInput)
  .handler(handleDeleteTabPin);

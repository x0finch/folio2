import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "../session/require-auth";
import { handleCreateTabPin } from "./create";
import { handleDeleteTabPin } from "./delete";
import { handleUpdateTabPinTarget } from "./update-target";

// 首页自定义 Tab(pin,ADR 0034)资源面:只做装配 → per-user 的 `TabPinStore`(ADR 0037)。
// 清单读取已并进 `getHomeTabStrip`(标签服务端解析好),这里只留三处写。
const PinTarget = z.object({
  kind: z.enum(["connector", "tag", "account"]),
  connectorId: z.string().optional(),
  tagId: z.string().optional(),
  accountId: z.string().optional(),
});

export const createTabPin = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(PinTarget)
  .handler(handleCreateTabPin);

export const updateTabPinTarget = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(PinTarget.extend({ pinId: z.string().min(1) }))
  .handler(handleUpdateTabPinTarget);

export const deleteTabPin = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(z.object({ pinId: z.string().min(1) }))
  .handler(handleDeleteTabPin);

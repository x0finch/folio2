import { createServerFn } from "@tanstack/react-start";
import { PortfolioSelectInput } from "@/lib/server/portfolio/scope";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { handleCreateTabPin, PinTargetInput } from "./create";
import { DeleteTabPinInput, handleDeleteTabPin } from "./delete";
import { handleGetPortfolioTabPins } from "./read";
import { handleUpdateTabPinTarget, UpdateTabPinInput } from "./update-target";

// 首页自定义 Tab(pin,ADR 0034)资源面:读 + 写装配。
// 读:`getPortfolioTabPins` 只发 pin 行;tab 条其余原料来自 overview / 标签 query 缓存。

export const getPortfolioTabPins = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioSelectInput)
  .handler(runEffect(handleGetPortfolioTabPins));

export const createTabPin = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(PinTargetInput)
  .handler(runEffect(handleCreateTabPin));

export const updateTabPinTarget = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(UpdateTabPinInput)
  .handler(runEffect(handleUpdateTabPinTarget));

export const deleteTabPin = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(DeleteTabPinInput)
  .handler(runEffect(handleDeleteTabPin));

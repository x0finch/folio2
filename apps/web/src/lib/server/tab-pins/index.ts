import { createServerFn } from "@tanstack/react-start";
import { PortfolioSelectInput } from "@/lib/server/portfolio/scope";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { handleCreateTabPin, PinTargetInput } from "./create";
import { DeleteTabPinInput, handleDeleteTabPin } from "./delete";
import { handleGetPortfolioTabPins } from "./read";
import { handleUpdateTabPinTarget, UpdateTabPinInput } from "./update-target";

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

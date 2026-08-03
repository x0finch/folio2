import type { ConnectorId } from "@folio/connectors";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "./internal/db";
import { requireAuth } from "./internal/require-auth";

// 首页自定义 Tab(pin,ADR 0034)的 server fn:auth 薄壳 → db 门面。每 user ≤3 的上限、tag 归属校验都在 db 层。

export const listTabPins = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(({ context }) => db.listTabPinsByUser(context.userId));

// pin 目标:connector pin 带 connectorId,tag pin 带 tagId(db 层再校验互斥非空 + tag 归属)。
const PinTarget = z.object({
  kind: z.enum(["connector", "tag"]),
  connectorId: z.string().optional(),
  tagId: z.string().optional(),
});

export const createTabPin = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(PinTarget)
  .handler(({ data, context }) =>
    db.createTabPin(context.userId, {
      kind: data.kind,
      connectorId: data.connectorId as ConnectorId | undefined,
      tagId: data.tagId,
    }),
  );

export const updateTabPinTarget = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(PinTarget.extend({ pinId: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    await db.updateTabPinTarget(context.userId, data.pinId, {
      kind: data.kind,
      connectorId: data.connectorId as ConnectorId | undefined,
      tagId: data.tagId,
    });
    return { ok: true as const };
  });

export const deleteTabPin = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(z.object({ pinId: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    await db.deleteTabPin(context.userId, data.pinId);
    return { ok: true as const };
  });

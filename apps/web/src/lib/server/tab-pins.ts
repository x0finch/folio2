import type { ConnectorId } from "@folio/connectors";
import { TabPinStore } from "@folio/db";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { runStore } from "./oracle";
import { requireAuth } from "./session/require-auth";

// 首页自定义 Tab(pin,ADR 0034)的 server fn:auth 薄壳 → per-user 的 `TabPinStore`(ADR 0037)。每 user ≤3 的上限、tag 归属校验都在 db 层。
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
  .handler(({ data, context }) =>
    runStore(context.userId, TabPinStore, (s) =>
      s.create({
        kind: data.kind,
        connectorId: data.connectorId as ConnectorId | undefined,
        tagId: data.tagId,
        accountId: data.accountId,
      }),
    ),
  );

export const updateTabPinTarget = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(PinTarget.extend({ pinId: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    await runStore(context.userId, TabPinStore, (s) =>
      s.updateTarget(data.pinId, {
        kind: data.kind,
        connectorId: data.connectorId as ConnectorId | undefined,
        tagId: data.tagId,
        accountId: data.accountId,
      }),
    );
    return { ok: true as const };
  });

export const deleteTabPin = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(z.object({ pinId: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    await runStore(context.userId, TabPinStore, (s) => s.remove(data.pinId));
    return { ok: true as const };
  });

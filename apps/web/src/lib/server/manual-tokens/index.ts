import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "../session/require-auth";
import { handleGetManualAccount } from "./get-account";
import { handleRemoveManualToken } from "./remove";

// manual token 资源面(账户级):只做装配(auth 经 ALS 带 userId + 校验入参),实现在 ../manual/store。
// 红线:只记安全字段,不打 creds(manual creds 全 public,但仍不入日志)。

export const getManualAccount = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ accountId: z.string().min(1) }))
  .handler(handleGetManualAccount);

export const removeManualToken = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(
    z.object({
      accountId: z.string().min(1),
      tokenId: z.string().min(1),
    }),
  )
  .handler(handleRemoveManualToken);

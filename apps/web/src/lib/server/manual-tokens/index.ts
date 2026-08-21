import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/server/session/require-auth";
import { GetManualAccountInput, handleGetManualAccount } from "./get-account";
import { handleRemoveManualToken, RemoveManualTokenInput } from "./remove";

// manual token 资源面(账户级):只做装配(auth 经 ALS 带 userId + 校验),实现在 ../manual/store。
// 红线:只记安全字段,不打 creds(manual creds 全 public,但仍不入日志)。

export const getManualAccount = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(GetManualAccountInput)
  .handler(handleGetManualAccount);

export const removeManualToken = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(RemoveManualTokenInput)
  .handler(handleRemoveManualToken);

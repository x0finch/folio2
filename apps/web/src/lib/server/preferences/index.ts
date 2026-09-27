import { createServerFn } from "@tanstack/react-start";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { CurrencyPreferenceInput, handleGetCurrencyPreference } from "./currency";

// 展示偏好的服务端那一半。只做装配。
//
// **只剩一个**:选哪个币种、用哪种语言都存在浏览器里(localStorage,ADR 0049 补记),服务端不再读写
// 偏好 cookie。剩下的这个是汇率 —— per-user 缓存,要 userId,所以挂 requireAuth。
export const getCurrencyPreference = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(CurrencyPreferenceInput)
  .handler(runEffect(handleGetCurrencyPreference));

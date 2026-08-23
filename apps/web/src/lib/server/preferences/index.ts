import { createServerFn } from "@tanstack/react-start";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import {
  handleGetCurrencyPreference,
  handleSetCurrencyPreference,
  SetCurrencyInput,
} from "./currency";
import { handleGetLocalePreference, handleSetLocalePreference, SetLocaleInput } from "./locale";

// 展示偏好(币种 / 语言)—— 浏览器级偏好,存 cookie + 请求头,非账户数据。只做装配。
// **鉴权按调用点分,不按「它敏不敏感」分**:语言切换器在登录页就要能用,所以 locale 两个公开;
// 币种读侧要 userId 取汇率(per-user 缓存),写侧就没理由敞着 —— 敞着等于凭空多一个
// 无凭据就能改别人显示状态的跨站 POST 目标。

// 只有读侧经 `runEffect` —— 它要参考层的汇率;另外三个只读/写 cookie,一个服务都不要。
export const getCurrencyPreference = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(runEffect(handleGetCurrencyPreference));

export const getLocalePreference = createServerFn({ method: "GET" }).handler(
  handleGetLocalePreference,
);

export const setCurrencyPreference = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(SetCurrencyInput)
  .handler(handleSetCurrencyPreference);

export const setLocalePreference = createServerFn({ method: "POST" })
  .validator(SetLocaleInput)
  .handler(handleSetLocalePreference);

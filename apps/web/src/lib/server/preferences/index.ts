import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "../session/require-auth";
import { handleGetCurrencyPreference, handleSetCurrencyPreference } from "./currency";
import { handleGetLocalePreference, handleSetLocalePreference } from "./locale";

// 展示偏好(币种 / 语言)—— 浏览器级偏好,存 cookie + 请求头,非账户数据。只做装配。
// **鉴权按调用点分,不按「它敏不敏感」分**:语言切换器在登录页就要能用,所以 locale 两个公开;
// 币种读侧要 userId 取汇率(per-user 缓存),写侧就没理由敞着 —— 敞着等于凭空多一个
// 无凭据就能改别人显示状态的跨站 POST 目标。

export const getCurrencyPreference = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(handleGetCurrencyPreference);

export const getLocalePreference = createServerFn({ method: "GET" }).handler(
  handleGetLocalePreference,
);

export const setCurrencyPreference = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(z.object({ code: z.string() }))
  .handler(handleSetCurrencyPreference);

export const setLocalePreference = createServerFn({ method: "POST" })
  .validator(z.object({ locale: z.string() }))
  .handler(handleSetLocalePreference);

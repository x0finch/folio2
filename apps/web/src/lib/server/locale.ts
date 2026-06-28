import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { pickLocale, readLocaleCookie } from "../i18n/detect";
import type { Locale } from "../i18n/messages";

// 服务端定 locale:读 folio_locale cookie + Accept-Language(纯逻辑在 detect.ts)。
// 无需鉴权(语言偏好非敏感);根路由 loader 调用 → SSR 首屏即正确语言。
export const getLocale = createServerFn({ method: "GET" }).handler((): Locale => {
  const headers = getRequestHeaders();
  return pickLocale(readLocaleCookie(headers.get("cookie")), headers.get("accept-language"));
});

import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { LOCALE_COOKIE, pickLocale, readLocaleCookie } from "../../i18n/detect";
import type { Locale } from "../../i18n/messages";
import { writePreferenceCookie } from "./cookie";

// 服务端定 locale:读 folio_locale cookie + Accept-Language(纯逻辑在 detect.ts)。
// 无需鉴权(语言偏好非敏感);根路由 loader 调用 → SSR 首屏即正确语言。
export function handleGetLocalePreference(): Locale {
  const headers = getRequestHeaders();
  return pickLocale(readLocaleCookie(headers.get("cookie")), headers.get("accept-language"));
}

// 语言切换器在登录页就要能用,所以写侧也是公开的(鉴权按调用点分,不按「它敏不敏感」分)。
export const SetLocaleInput = z.object({ locale: z.string() });

export function handleSetLocalePreference({ data }: { data: z.infer<typeof SetLocaleInput> }) {
  // `pickLocale` 认不出来就落默认,写进去的一定是合法 locale。
  writePreferenceCookie(LOCALE_COOKIE, pickLocale(data.locale, null));
}

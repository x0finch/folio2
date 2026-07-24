import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getAuth } from "../auth";

// 公开 server fn(非 authed):返回当前 user 或 null,不抛。
// 仅供路由守卫(_authed.tsx beforeLoad)做 UX 级重定向;真正的数据安全边界是
// 各 authedServerFn(无 session 抛 401)。
export const getSession = createServerFn({ method: "GET" }).handler(async () => {
  const result = await getAuth().api.getSession({ headers: getRequestHeaders() });
  return result ? { user: result.user } : null;
});

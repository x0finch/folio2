import { getRequestHeaders } from "@tanstack/react-start/server";
import { getAuth } from "./auth";

// 公开 handler(非 authed):返回当前 user 或 null,不抛。
// 仅供路由守卫(_authed.tsx beforeLoad)做 UX 级重定向;真正的数据安全边界是
// 各 authedServerFn(无 session 抛 401)。
export async function handleGetSession() {
  const result = await getAuth().api.getSession({ headers: getRequestHeaders() });
  return result ? { user: result.user } : null;
}

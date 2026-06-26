import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "../require-auth";

// 受保护 server function 的构造器:预挂 requireAuth 守卫。
// 用法:authedServerFn({ method: "GET" }).handler(({ context }) => ...context.userId)
// 既 DRY 又保留显式边界 + context.userId 强类型(安全边界仍是 server fn 本身)。
export function authedServerFn(options?: Parameters<typeof createServerFn>[0]) {
  return createServerFn(options).middleware([requireAuth]);
}

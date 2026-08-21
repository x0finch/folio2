import { TagStore } from "@folio/db";
import { runStore } from "@/lib/server/oracle";
import type { AuthContext } from "@/lib/server/session/auth-session";

// 账户→Tag 关联整份返回,展示富化在客户端按 accountId 组装(同 memberships 的做法)。
export function handleListAccountTags({ context }: { context: AuthContext }) {
  return runStore(context.userId, TagStore, (s) => s.listAccountLinks());
}

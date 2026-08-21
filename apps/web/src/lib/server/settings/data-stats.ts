import { AccountStore } from "@folio/db";
import { runStore } from "@/lib/server/oracle";
import type { AuthContext } from "@/lib/server/session/auth-session";

// 库里是否已有账户数据(设置页导入前的提醒用):非空则合并式导入前弹一道确认。只回布尔。
export async function handleGetDataStats({ context }: { context: AuthContext }) {
  return {
    hasData: (await runStore(context.userId, AccountStore, (s) => s.list())).length > 0,
  };
}

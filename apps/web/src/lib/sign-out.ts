import type { QueryClient } from "@tanstack/react-query";
import { signOut } from "./auth-client";
import { clearIdleLockState } from "./hooks/use-idle-lock";

/**
 * 登出的完整动作 —— 两个入口(设置页、锁屏)共用,不许各写一半。
 *
 * **必须掐掉在飞的查询、并清空缓存**,理由有两条,都不显然:
 *
 * ① **缓存里是上一个人的数据。** 不清就留在那儿:同一台机器换个人登录,他会先看到前一个人的
 *    净值与持仓,直到各条查询自己刷新为止。只读看板也是隐私。
 *
 * ② **在飞的那些会把刚打开的登录页顶掉。** 会话没了之后它们以「重定向」失败,而 SSR query 集成
 *    在 query 报重定向错误时会**再调一次 `router.navigate`**(见 router-ssr-query-core 的
 *    `queryCache.config.onError`)。于是人已经站在登录页上,路由又被导航一次、整页重挂 —— 正在
 *    输入的表单当场被换掉。e2e 里表现为「填好密码按回车,输入框 detached」,而且只偶发:
 *    要恰好有一条查询在这个窗口里落地。首页的 loader 改成「发出即返回」之后(#488),
 *    这个窗口比以前更容易撞上。
 *
 * `clearIdleLockState` 同样不能漏:不清的话重新登录会因旧的 lastActive 已过期而当场被锁(#353)。
 */
export async function signOutEverywhere(queryClient: QueryClient): Promise<void> {
  clearIdleLockState();
  await signOut();
  // 顺序要紧:先取消再清。清空不会中止已经发出的请求,只有 cancel 会 —— 漏掉它就还剩一批
  // 会落地、会报重定向、会把登录页顶掉的请求。
  await queryClient.cancelQueries();
  queryClient.clear();
}

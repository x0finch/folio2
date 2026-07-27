import { oracleFor } from "./oracle2";

// 汇率预热。**按用户**(#202b):汇率行住在 per-user 缓存里(`user_cache` 的 `fx:<币种>` 键),
// 与代币目录、平台名图同一张表 —— 参考层的一切都 per-user,只有那两张公开知识表例外(原则 #6)。
//
// 汇率本身当然跟用户无关。之所以还是每人一份:这张表只装这个用户真的碰到过的东西
// (他选的那个币种),而全局一份就得装所有人的并集,还要为「谁负责刷」再发明一套规则。
// 自托管场景下这份重复的代价是十几行。
//
// 读走 `resolve`(软过期,给最近值),写走 `warm`(同步后 / 首次切币种时)。
export async function warmFx(userId: string): Promise<void> {
  await oracleFor(userId).fx.warm();
}

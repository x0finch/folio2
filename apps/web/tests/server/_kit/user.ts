import { env } from "cloudflare:test";

// **每个用例开头拿一个干净用户。**
//
// 重置靠删 `user` 那一行:库里所有 per-user 表都从它级联下来(D1 真的执行 FK,ADR 0022),
// 所以删一行等于把这个用户的账户、快照、tag、pin、活动、设置一次清空。逐表 DELETE 会漏 ——
// 加了新表就要记得改那份名单,而漏掉的表会让**上一个用例的数据泄进下一个**。
//
// 这套测试跑在 workers-pool 里,而这一版的 pool **不做 per-test 存储隔离**(CLAUDE.md 记着),
// 所以「谁负责清」必须是显式的:每个测试文件用自己的 userId 前缀,`beforeEach` 里清一次。
export const freshUser = async (userId: string): Promise<string> => {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(userId).run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(userId, userId, `${userId}@example.test`, 0, now, now)
    .run();
  return userId;
};

/** 另一个用户 —— 越权用例要有个「别人」才测得了。 */
export const otherUser = (userId: string) => `${userId}-other`;

import { env } from "cloudflare:test";

// Reset by deleting the `user` row: every per-user table cascades from it (D1 enforces FKs), so no
// per-table list can go stale. The workers pool doesn't isolate storage per test, so each file uses
// its own userId prefix and resets in `beforeEach`.
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

export const otherUser = (userId: string) => `${userId}-other`;

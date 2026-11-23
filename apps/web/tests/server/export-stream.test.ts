import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { exportStream } from "@/lib/server/io/export-stream";
import { runForUser } from "@/lib/server/runtime";

// Pagination boundaries of the export stream. The roundtrip test re-implements the export logic by hand, so
// `Stream.paginateEffect` (where a page could be fetched twice, skipped or duplicated) was never exercised.
// Three sizes pin it: 0, exactly one page (50), one page plus one (51). Uses the production assembly via `runForUser`.

const USER = "user-export-stream";
const SNAPSHOT_PAGE = 50; // same as routes/api/export.ts (not exported there)

async function resetUser(): Promise<void> {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
}

// Insert rows directly, bypassing writeSnapshot: only "N snapshot rows" matters here.
async function seedSnapshots(count: number): Promise<void> {
  if (count === 0) return;
  await env.DB.prepare(
    "INSERT INTO accounts (id, user_id, connector_id, label, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind("acc-export", USER, "evm", "W", Date.now())
    .run();
  await env.DB.batch(
    Array.from({ length: count }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO snapshots (id, account_id, taken_at, total_usd) VALUES (?, ?, ?, ?)",
      ).bind(`snap-${i}`, "acc-export", 1_700_000_000_000 + i, i),
    ),
  );
}

async function exportLines(): Promise<Record<string, unknown>[]> {
  const body = await runForUser(USER, exportStream());
  const text = await new Response(body).text();
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(resetUser);

describe("export stream pagination boundaries", () => {
  it("empty DB -- only the meta row, no throw or hang on an empty first page", async () => {
    const lines = await exportLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe("meta");
  });

  it("exactly one page -- 50 rows (needs one extra upstream request to learn it ended)", async () => {
    await seedSnapshots(SNAPSHOT_PAGE);
    const snaps = (await exportLines()).filter((l) => l.type === "snapshot");
    expect(snaps).toHaveLength(SNAPSHOT_PAGE);
    // No duplicates: each snapshot appears once (a boundary row twice is the typical paging bug). Identify by `takenAt`; export rows carry no id.
    expect(new Set(snaps.map((s) => s.takenAt)).size).toBe(SNAPSHOT_PAGE);
  });

  it("one page plus one -- all 51 present, short last page loses nothing", async () => {
    await seedSnapshots(SNAPSHOT_PAGE + 1);
    const snaps = (await exportLines()).filter((l) => l.type === "snapshot");
    expect(snaps).toHaveLength(SNAPSHOT_PAGE + 1);
    expect(new Set(snaps.map((s) => s.takenAt)).size).toBe(SNAPSHOT_PAGE + 1);
  });

  // Order is a format contract: import is single-pass, so token rows must precede the snapshot / activity rows that reference them.
  it("section order: meta first, accounts before snapshots", async () => {
    await seedSnapshots(2);
    const kinds = (await exportLines()).map((l) => l.type);
    expect(kinds[0]).toBe("meta");
    expect(kinds.indexOf("account")).toBeLessThan(kinds.indexOf("snapshot"));
  });
});

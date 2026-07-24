import type { SnapshotBalance } from "@folio/db";
import { getLogger } from "@logtape/logtape";
import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "@/lib/auth";
import { resolveAuth } from "@/lib/auth-session";
import { safeView } from "@/lib/creds";
import {
  accountRecord,
  groupRecord,
  membershipRecord,
  metaRecord,
  ndjsonLine,
  snapshotRecord,
} from "@/lib/export";
import { credentialSpecs } from "@/lib/server/internal/connector-registry";
import { db } from "@/lib/server/internal/db";

// 每页快照数:配 inArray(≤ 50 ids) 取余额,远低于 D1 100 绑定参数上限。
const SNAPSHOT_PAGE = 50;

// GET /api/export —— 把用户全部数据导成 NDJSON 文件(流式、分页、剥密钥)。鉴权同其它 server fn。
export const Route = createFileRoute("/api/export")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const session = await getAuth().api.getSession({ headers: request.headers });
        let userId: string;
        try {
          userId = resolveAuth(session).userId;
        } catch (err) {
          getLogger(["folio", "web", "export"]).warning("export unauthorized");
          return err instanceof Response ? err : new Response("Unauthorized", { status: 401 });
        }
        getLogger(["folio", "web", "export"]).info("export started", { userId });

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const write = (record: unknown) =>
              controller.enqueue(encoder.encode(ndjsonLine(record)));
            try {
              write(metaRecord(Date.now())); // 首行:版本号等

              const specsByType = credentialSpecs();
              const accounts = await db.listAccountsByUser(userId);
              for (const a of accounts) {
                // 安全投影(无需解密):public 原样、semi 打码、secret 丢弃 —— 绝不导出完整密钥。
                const raw = await db.getRawCreds(userId, a.id);
                const stored: Record<string, string> = raw ? JSON.parse(raw) : {};
                write(accountRecord(a, safeView(specsByType[a.connectorId] ?? [], stored)));
              }

              for (const g of await db.listGroupsByUser(userId)) write(groupRecord(g));
              for (const m of await db.listMembershipsByUser(userId)) write(membershipRecord(m));

              // 快照:分页拉取,每页取该页余额、流式写出 → 内存恒定,绕开参数上限。
              for (let offset = 0; ; offset += SNAPSHOT_PAGE) {
                const page = await db.listSnapshotsPageByUser(userId, SNAPSHOT_PAGE, offset);
                if (page.length === 0) break;
                const pageBalances = await db.listBalancesForSnapshots(page.map((s) => s.id));
                const bySnapshot = new Map<string, SnapshotBalance[]>();
                for (const b of pageBalances) {
                  const arr = bySnapshot.get(b.snapshotId);
                  if (arr) arr.push(b);
                  else bySnapshot.set(b.snapshotId, [b]);
                }
                for (const s of page) write(snapshotRecord(s, bySnapshot.get(s.id) ?? []));
                if (page.length < SNAPSHOT_PAGE) break;
              }

              controller.close();
            } catch (err) {
              controller.error(err);
            }
          },
        });

        return new Response(stream, {
          headers: {
            "content-type": "application/x-ndjson; charset=utf-8",
            "content-disposition": 'attachment; filename="folio-export.ndjson"',
          },
        });
      },
    },
  },
});

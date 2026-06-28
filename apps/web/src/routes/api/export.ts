import { env } from "cloudflare:workers";
import { decrypt, getProvider, secretKeys } from "@folio/core";
import {
  getEncryptedCredentials,
  listAccountsByUser,
  listBalancesForSnapshots,
  listGroupsByUser,
  listMembershipsByUser,
  listSnapshotsPageByUser,
  type SnapshotBalance,
} from "@folio/db";
import { appRegistry } from "@folio/sync";
import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "@/lib/auth";
import { resolveAuth } from "@/lib/auth-session";
import {
  accountRecord,
  groupRecord,
  membershipRecord,
  metaRecord,
  ndjsonLine,
  snapshotRecord,
} from "@/lib/export";

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
          return err instanceof Response ? err : new Response("Unauthorized", { status: 401 });
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const write = (record: unknown) =>
              controller.enqueue(encoder.encode(ndjsonLine(record)));
            try {
              write(metaRecord(Date.now())); // 首行:版本号等

              const accounts = await listAccountsByUser(env, userId);
              for (const a of accounts) {
                const encCreds = await getEncryptedCredentials(env, userId, a.id);
                const creds: Record<string, string> = encCreds
                  ? JSON.parse(await decrypt(encCreds, env.SECRETS_KEY))
                  : {};
                const sk = secretKeys(getProvider(appRegistry, a.type).inputs ?? []);
                write(accountRecord(a, creds, sk)); // 密钥已剥离
              }

              for (const g of await listGroupsByUser(env, userId)) write(groupRecord(g));
              for (const m of await listMembershipsByUser(env, userId)) write(membershipRecord(m));

              // 快照:分页拉取,每页取该页余额、流式写出 → 内存恒定,绕开参数上限。
              for (let offset = 0; ; offset += SNAPSHOT_PAGE) {
                const page = await listSnapshotsPageByUser(env, userId, SNAPSHOT_PAGE, offset);
                if (page.length === 0) break;
                const balances = await listBalancesForSnapshots(
                  env,
                  page.map((s) => s.id),
                );
                const bySnapshot = new Map<string, SnapshotBalance[]>();
                for (const b of balances) {
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

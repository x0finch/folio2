import type { SnapshotBalanceInput } from "@folio/db";
import { getLogger } from "@logtape/logtape";
import { createFileRoute } from "@tanstack/react-router";
import type { AccountType } from "@/lib/account-types";
import { getAuth } from "@/lib/auth";
import { resolveAuth } from "@/lib/auth-session";
import { categorizeFields } from "@/lib/creds";
import { createImporter, type ImportDeps, ImportError, parseImportLine } from "@/lib/import";
import { credentialSpecs } from "@/lib/server/connectors";
import { db } from "@/lib/server/db";

// POST /api/import —— 流式读 NDJSON 重建账户/分组/历史(单遍 + id 重映射)。鉴权同其它 server fn。
// CEX 账户(有 secret 输入、导出已剥密钥)→ encCredentials=null = 缺凭据态,待补录。
export const Route = createFileRoute("/api/import")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const session = await getAuth().api.getSession({ headers: request.headers });
        let userId: string;
        try {
          userId = resolveAuth(session).userId;
        } catch (err) {
          getLogger(["folio", "web", "import"]).warning("import unauthorized");
          return err instanceof Response ? err : new Response("Unauthorized", { status: 401 });
        }
        const reader = request.body?.getReader();
        if (!reader) return new Response("empty body", { status: 400 });

        const deps: ImportDeps = {
          categorize: (type) => {
            // 从公开字段规格按暴露级别分桶(import 重建 creds 用);不碰 provider 内部。
            const f = categorizeFields(credentialSpecs()[type as AccountType] ?? []);
            return { publicKeys: f.public, semiKeys: f.semi, secretKeys: f.secret };
          },
          createAccount: (input) =>
            db.createAccount(userId, { ...input, type: input.type as AccountType }),
          createGroup: (input) => db.createGroup(userId, input),
          addAccountToGroup: (accountId, groupId) =>
            db.addAccountToGroup(userId, accountId, groupId),
          writeSnapshot: async (accountId, input) => {
            // 边界透传:db 的 SnapshotBalanceInput.kind 仍是旧 4 值 BalanceKind(#37c 前),
            // 而导入文件的 kind 是 connectors 的 5-kind;运行期只作 text 存储,按契约断言透传(同 @folio/sync)。
            await db.writeSnapshot(userId, accountId, {
              ...input,
              balances: input.balances.map((b) => ({
                ...b,
                kind: b.kind as SnapshotBalanceInput["kind"],
              })),
            });
          },
        };
        const importer = createImporter(deps);

        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl = buffer.indexOf("\n");
            while (nl >= 0) {
              const rec = parseImportLine(buffer.slice(0, nl));
              buffer = buffer.slice(nl + 1);
              if (rec) await importer.apply(rec);
              nl = buffer.indexOf("\n");
            }
          }
          const last = parseImportLine(buffer); // 末尾无换行的一行
          if (last) await importer.apply(last);
          getLogger(["folio", "web", "import"]).info("import complete", {
            userId,
            ...importer.counts,
          });
          return Response.json({ imported: importer.counts });
        } catch (err) {
          const msg = err instanceof ImportError ? err.message : "import failed";
          getLogger(["folio", "web", "import"]).warning("import rejected", { userId, error: msg });
          return new Response(msg, { status: 400 });
        }
      },
    },
  },
});

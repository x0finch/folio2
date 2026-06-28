import { env } from "cloudflare:workers";
import { type AccountType, getProvider, publicKeys, secretKeys, semiKeys } from "@folio/core";
import { addAccountToGroup, createAccount, createGroup, writeSnapshot } from "@folio/db";
import { appRegistry } from "@folio/sync";
import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "@/lib/auth";
import { resolveAuth } from "@/lib/auth-session";
import { createImporter, type ImportDeps, ImportError, parseImportLine } from "@/lib/import";

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
          return err instanceof Response ? err : new Response("Unauthorized", { status: 401 });
        }
        const reader = request.body?.getReader();
        if (!reader) return new Response("empty body", { status: 400 });

        const deps: ImportDeps = {
          categorize: (type) => {
            const inputs = getProvider(appRegistry, type as AccountType).inputs ?? [];
            return {
              publicKeys: publicKeys(inputs),
              semiKeys: semiKeys(inputs),
              secretKeys: secretKeys(inputs),
            };
          },
          createAccount: (input) =>
            createAccount(env, userId, { ...input, type: input.type as AccountType }),
          createGroup: (input) => createGroup(env, userId, input),
          addAccountToGroup: (accountId, groupId) =>
            addAccountToGroup(env, userId, accountId, groupId),
          writeSnapshot: async (accountId, input) => {
            await writeSnapshot(env, userId, accountId, input);
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
          return Response.json({ imported: importer.counts });
        } catch (err) {
          const msg = err instanceof ImportError ? err.message : "import failed";
          return new Response(msg, { status: 400 });
        }
      },
    },
  },
});

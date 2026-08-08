import type { ConnectorId } from "@folio/connectors";
import { type SnapshotBalanceInput, TransferStore } from "@folio/db";
import { getLogger } from "@logtape/logtape";
import { createFileRoute } from "@tanstack/react-router";
import { Effect, Either } from "effect";
import { categorizeFields } from "@/lib/creds";
import { createImporter, type ImportDeps, parseImportLine } from "@/lib/import";
import { getAuth } from "@/lib/server/internal/auth";
import { resolveAuth } from "@/lib/server/internal/auth-session";
import { credentialSpecs } from "@/lib/server/internal/connector-registry";
import { runRequest } from "@/lib/server/internal/oracle";

// POST /api/import —— 流式读 NDJSON 重建账户/分组/历史(单遍 + id 重映射)。鉴权同其它 server fn。
// CEX 账户(有 secret 输入、导出已剥密钥)→ encCredentials=null = 缺凭据态,待补录。
//
// **整条导入一个 effect,一次装配**(#394 T7):读流、解析、写库共一份 context。以前四个写口各自
// 经过渡门面调用,而门面每次都建一次 layer + 跑一次 `runPromise` —— 一个几万行的文件就是几万次。

// `TransferStore` → `ImportDeps`。写口全在服务上,这里只做「文件里的形状 → 库里的形状」那一层翻译。
const depsFrom = (transfer: TransferStore): ImportDeps => ({
  categorize: (connectorId) => {
    // 从公开字段规格按暴露级别分桶(import 重建 creds 用);不碰 provider 内部。
    const f = categorizeFields(credentialSpecs()[connectorId as ConnectorId] ?? []);
    return { publicKeys: f.public, semiKeys: f.semi, secretKeys: f.secret };
  },
  importToken: (t, refs) => Effect.map(transfer.importToken(t, refs), (id) => ({ id })),
  importAccount: (input) =>
    transfer.importAccount({ ...input, connectorId: input.connectorId as ConnectorId }),
  importSnapshot: (accountId, input) =>
    // 边界透传:db 的 SnapshotBalanceInput.kind 仍是旧 4 值 BalanceKind(#37c 前),
    // 而导入文件的 kind 是 connectors 的 5-kind;运行期只作 text 存储,按契约断言透传(同 @folio/sync)。
    Effect.asVoid(
      transfer.importSnapshot(accountId, {
        ...input,
        balances: input.balances.map((b) => ({
          ...b,
          kind: b.kind as SnapshotBalanceInput["kind"],
        })),
      }),
    ),
  importManualActivity: (accountId, tokenId, input) =>
    Effect.asVoid(transfer.importManualActivity(accountId, tokenId, input)),
});

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

        // `ImportError`(格式不对 / 版本太旧)是**用户要看到的那条** —— 它在 `apply` 里是类型化
        // 失败,所以这里用 `Effect.either` 接住,而不是靠 `catch` 从 `FiberFailure` 的 cause 里刨。
        const result = await runRequest(
          userId,
          Effect.either(
            Effect.gen(function* () {
              const importer = createImporter(depsFrom(yield* TransferStore));
              const decoder = new TextDecoder();
              let buffer = "";
              for (;;) {
                const { done, value } = yield* Effect.promise(() => reader.read());
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let nl = buffer.indexOf("\n");
                while (nl >= 0) {
                  const rec = parseImportLine(buffer.slice(0, nl));
                  buffer = buffer.slice(nl + 1);
                  if (rec) yield* importer.apply(rec);
                  nl = buffer.indexOf("\n");
                }
              }
              const last = parseImportLine(buffer); // 末尾无换行的一行
              if (last) yield* importer.apply(last);
              return importer.counts;
            }),
          ),
        );
        if (Either.isLeft(result)) {
          const msg = result.left.message;
          getLogger(["folio", "web", "import"]).warning("import rejected", { userId, error: msg });
          return new Response(msg, { status: 400 });
        }
        const counts = result.right;
        getLogger(["folio", "web", "import"]).info("import complete", { userId, ...counts });
        return Response.json({ imported: counts });
      },
    },
  },
});

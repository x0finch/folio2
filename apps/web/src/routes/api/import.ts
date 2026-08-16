import type { ConnectorId } from "@folio/connectors";
import { type SnapshotBalanceInput, TransferStore } from "@folio/db";
import { getLogger } from "@logtape/logtape";
import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
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

        // **三种收场,分得清清楚楚**:
        //   · `ok`       —— 200 + 计数
        //   · `rejected` —— 400。`ImportError`(格式不对 / 版本太旧)是**用户要看到的那条**,
        //                   它在 `apply` 里是类型化失败,`catchAll` 接住,消息原样发回。
        //   · `failed`   —— 500。D1 写挂了、客户端半路断开导致 `reader.read()` 拒绝,这些是
        //                   defect。**不能当 400 发** —— 那等于告诉用户「你的文件有问题」,
        //                   而问题在我们这边。
        //
        // 三条都记一行带 userId 的日志。迁移前那圈 `catch` 是把两类失败一起收成 400 + 一句
        // 「import failed」;分开之后 400 那半更准了,但**日志不能跟着丢** —— 只接类型化失败的话,
        // defect 会一路穿到框架的 500,这个端点就再没有自己的错误记录了。
        const outcome = await runRequest(
          userId,
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
          }).pipe(
            Effect.map((counts) => ({ kind: "ok", counts }) as const),
            Effect.catchAll((e) =>
              Effect.succeed({ kind: "rejected", message: e.message } as const),
            ),
            // `catchAllDefect` 在 `catchAll` 之后:前者接类型化失败,后者接 defect,两个通道
            // 各接各的(CODING.md:「`E` 里只放有人会处理的东西,其余走 defect」)。
            Effect.catchAllDefect((d) =>
              Effect.succeed({
                kind: "failed",
                message: d instanceof Error ? d.message : String(d),
              } as const),
            ),
          ),
        );

        const log = getLogger(["folio", "web", "import"]);
        if (outcome.kind === "rejected") {
          log.warning("import rejected", { userId, error: outcome.message });
          return new Response(outcome.message, { status: 400 });
        }
        if (outcome.kind === "failed") {
          log.error("import failed", { userId, error: outcome.message });
          // 内情不回给客户端(设置页导入会原样显示服务端纯文本);日志里有。
          return new Response("import failed", { status: 500 });
        }
        log.info("import complete", { userId, ...outcome.counts });
        return Response.json({ imported: outcome.counts });
      },
    },
  },
});

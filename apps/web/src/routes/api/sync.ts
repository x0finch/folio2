import { waitUntil } from "cloudflare:workers";
import { syncUserStream } from "@folio/sync";
import { getLogger } from "@logtape/logtape";
import { createFileRoute } from "@tanstack/react-router";
import { Effect, Queue, Stream } from "effect";
import { getAuth } from "@/lib/server/internal/auth";
import { resolveAuth } from "@/lib/server/internal/auth-session";
import { buildSyncDeps, warmTokensForUser } from "@/lib/server/internal/sync-deps";

// POST /api/sync —— 同步当前用户的全部账户,**逐账户以 NDJSON 流回进度**。
//
// 为什么不是前端逐个调 /syncAccount(以前的做法):那是 N 次往返,而且用户得一直停在页面上,
// 关掉标签同步就断在半路。
//
// 这里把「跑」和「看」拆开:
//   · 跑 —— 后台一个任务跑完整轮,`waitUntil` 兜住,与连接无关
//   · 看 —— 响应流只是观察窗,前端断开只是没人读了,跑的那头照常跑完
//
// 两者之间用一个 Effect Queue 接力:同步那头 offer,响应流那头 take。
// 注:`waitUntil` 从 `cloudflare:workers` 直接取(fetch 路径拿不到 ExecutionContext)。

const log = getLogger(["folio", "web", "sync"]);

const encoder = new TextEncoder();

export const Route = createFileRoute("/api/sync")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const session = await getAuth().api.getSession({ headers: request.headers });
        let userId: string;
        try {
          userId = resolveAuth(session).userId;
        } catch (err) {
          log.warning("sync stream unauthorized");
          return err instanceof Response ? err : new Response("Unauthorized", { status: 401 });
        }

        const deps = buildSyncDeps();

        const body = await Effect.runPromise(
          Effect.gen(function* () {
            // 无界队列:同步那头绝不因为前端读得慢(或根本不读)而被卡住。
            // 一轮同步的结果最多是账户数条,量很小。
            const queue = yield* Queue.unbounded<string>();

            // 跑:整轮同步 + 同步后的预热。**不 await** —— 交给 waitUntil,与连接脱钩。
            const run = Effect.runPromise(
              syncUserStream(deps, userId).pipe(
                Stream.runForEach((result) => Queue.offer(queue, `${JSON.stringify(result)}\n`)),
                // 用户级失败(取账户/取凭据挂了)也要让前端看见,别让流静默地空着结束。
                Effect.catchAll((e) =>
                  Queue.offer(queue, `${JSON.stringify({ fatal: e.message })}\n`).pipe(
                    Effect.tap(() =>
                      Effect.sync(() =>
                        log.error("sync stream failed", { userId, error: e.message }),
                      ),
                    ),
                  ),
                ),
                // 同步完预热代币缓存(best-effort),让下次总览能 cache-only 富化新价。
                Effect.tap(() => Effect.promise(() => warmTokensForUser(userId).catch(() => {}))),
                // 收尾:关队列 → 响应流自然结束。
                Effect.ensuring(Queue.shutdown(queue)),
              ),
            );
            waitUntil(run);

            // 看:队列 → NDJSON 字节流。前端断开只影响这一头。
            return Stream.fromQueue(queue, { shutdown: false }).pipe(
              Stream.map((line) => encoder.encode(line)),
              Stream.toReadableStream,
            );
          }),
        );

        return new Response(body, {
          headers: {
            "content-type": "application/x-ndjson; charset=utf-8",
            // 逐行推,别让任何一层攒着。
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      },
    },
  },
});

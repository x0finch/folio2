import { waitUntil } from "cloudflare:workers";
import { getLogger } from "@logtape/logtape";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { runForUser } from "@/lib/server/runtime";
import { requireUserId } from "@/lib/server/session/route-auth";
import { openSyncRound, runSyncRound } from "@/lib/server/sync/round";
import { syncRoundView } from "@/lib/server/sync/status";

const log = getLogger(["folio", "web", "sync"]);

// 路由文件只做 HTTP 入口转发;实现见 lib/server/sync/round.ts。
// waitUntil 从 cloudflare:workers 取(fetch 路径拿不到 ExecutionContext)。
//
// **开轮即返,进度靠轮询**(ADR 0048)。以前这里回的是一条 NDJSON 观察流,前端边收边推进它
// 自己那份进度 —— 那份进度住在浏览器里,于是跨页、跨设备、cron 的轮全都看不见,而「跑」和
// 「看」还得靠一个无界队列小心地解耦。现在这个 handler 只做两件事:抢下这一轮,把它交给
// `waitUntil`;进度是服务端事实,前端拿 `getSyncRound` 去读。
//
// **开轮幂等,所以重复 POST 不会叠出第二轮**:活轮还在时 `opened` 为假,这里就不再起一条后台
// 任务,直接把正在跑的那一轮原样回给调用方。

// 请求体只带「我在看哪个组合」(ADR 0047)。**不收账户名单** —— 这一轮跑哪些账户由服务端算。
// 空 body / 坏 JSON / 认不出的 id 一律当没带 = 默认组合:这是个按钮触发的动作,不该因为一个
// 参数没解出来就 400。
const Body = z.object({ portfolioId: z.string().min(1).optional() }).catch({});

const portfolioOf = async (request: Request): Promise<string | undefined> => {
  try {
    return Body.parse(await request.json()).portfolioId;
  } catch {
    return undefined;
  }
};

export const Route = createFileRoute("/api/sync")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const userId = await requireUserId(request);
        if (userId instanceof Response) {
          log.warning("sync round unauthorized");
          return userId;
        }

        const portfolioId = await portfolioOf(request);
        const { round, opened } = await runForUser(
          userId,
          openSyncRound({ portfolioId, trigger: "manual" }),
        );
        if (opened) waitUntil(runSyncRound(userId, round));

        // 回的是这一轮此刻的样子,好让面板立刻有东西可画(等第一次轮询要 1.5 秒)。
        return Response.json(syncRoundView(round, Date.now()), {
          headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
        });
      },
    },
  },
});

import { env } from "cloudflare:workers";
import type { ConnectorId } from "@folio/connectors";
import { type AccountSafe, Database } from "@folio/db";
import type { Oracle } from "@folio/oracle";
import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import { z } from "zod";
import { isManual } from "@/lib/core/manual";
import { ConnectorRegistry } from "@/lib/server/connectors/registry";
import { sealCreds } from "@/lib/server/creds";
import { createManualAccount } from "@/lib/server/manual/store";
import { invalidatePrecomputed } from "@/lib/server/portfolio/precompute";

// 账户创建的分派逻辑(handler 之外的纯 Effect → 不引 createServerFn/requireAuth,可在 workers-pool 集成测)。
// createAccount server fn(见 ./index)只做装配;auth 薄壳即 handleCreateAccount。SECRETS_KEY 只在此 app 层见,不进 connectors。
const log = getLogger(["folio", "web", "accounts"]);

// connectors 层校验/规格 → 业务层按字段 type seal(只有 secret 加密,public/semi 明文)。
// **规格由调用方从门票上取好传进来**(#504 T14)—— 这个函数是 SECRETS_KEY 那一侧的活儿
//(原则 #5),不该顺手去认识 connector registry。
export const raw2sealed = async (
  specs: ConnectorRegistry["specs"],
  connectorId: ConnectorId,
  values: Record<string, string>,
) => JSON.stringify(await sealCreds(specs[connectorId] ?? [], values, env.SECRETS_KEY));

// 统一创建入口(connector-driven):过滤空串 → 对**所有 connector** 统一 validateAccountCreds(形状闸 + 活性探活;
// manual 跑的即 provider 的 manualToken schema)→ 按 connector 分派创建:manual 走账本(取首 token → 建 token 行
// + 开仓 set 活动 + 物化 creds.tokens,见 createManualAccount),其余 seal 落库。
// **出口是 Effect**(#394 T6):调用方(createAccount server fn)把「建账户 → 归属到选中的
// Portfolio」拼进同一次装配,userId 只在那一处出现。
export const createAccountFor = (
  connectorId: ConnectorId,
  label: string,
  rawValues: Record<string, string>,
): Effect.Effect<AccountSafe, Error, ConnectorRegistry | Database | Oracle> =>
  Effect.gen(function* () {
    const connectors = yield* ConnectorRegistry;
    // 丢掉空串:未填的可选字段缺省即不参与;必填字段留空 → 变 undefined → 校验直接拒。
    const values = Object.fromEntries(Object.entries(rawValues).filter(([, v]) => v !== ""));
    // 校验失败是**用户看得见的那条错**(表单上「地址不对」),所以走类型化失败而不是 defect ——
    // 后者会被 `runPromise` 裹成 FiberFailure,前端只剩一坨 Cause。
    yield* connectors.validate(connectorId, values, { liveness: true, label });

    const account = yield* isManual(connectorId)
      ? createManualAccount(label, values.tokens)
      : Effect.gen(function* () {
          const creds = yield* Effect.promise(() =>
            raw2sealed(connectors.specs, connectorId, values),
          );
          return yield* (yield* Database).accounts.create({ connectorId, label, creds });
        });
    log.info("account created", { connectorId, accountId: account.id });
    return account;
  });

// 统一创建入口(connector-driven,#55/#52):校验/分派在上面的 createAccountFor;这里把
// 「建账户 → 归属到选中的 Portfolio」拼进同一次装配(#394 T6),userId 只在这一处出现。
// values:表单原始输入(键 = connector.account.creds 的 key);trim 后落库。
// portfolioId:落在当前选中的 Portfolio(ADR 0033);缺省 → 服务端本就落默认 Portfolio。
export const CreateAccountInput = z.object({
  connectorId: z.string().min(1),
  label: z.string().trim().min(1, "label is required"),
  values: z.record(z.string(), z.string().trim()),
  portfolioId: z.string().min(1).optional(),
});

export const handleCreateAccount = Effect.fn("createAccount")(function* (
  data: z.infer<typeof CreateAccountInput>,
) {
  const account = yield* createAccountFor(data.connectorId as ConnectorId, data.label, data.values);
  // createAccountFor 已把账户落进默认 Portfolio;若指定了非默认的选中,改归属过去。
  const portfolioId = data.portfolioId;
  if (portfolioId) {
    yield* (yield* Database).portfolios.assignAccount(account.id, portfolioId);
  }
  // 组合的值变了 → 预计算的 24h 盈亏不再可信,就地标旧(ADR 0049;为什么标旧不是删,见那边)。
  yield* invalidatePrecomputed();
  return account;
});

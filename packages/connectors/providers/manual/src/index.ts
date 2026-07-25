import type { BalanceProvider, CredField, Spot } from "@folio/connectors-basic";
import { tokenRef } from "@folio/oracle-ref";
import { z } from "zod";

// @folio/connectors-provider-manual —— 手动资产(manual connector 的 provider)。无外部 API:一个账户
// 持有 N 个手记 token(ADR 0017)。各 token 的定义 + 各自账本折叠出的 amount,由 app 物化成一个 public
// JSON 字段 `creds.tokens`(明文落库、导出原样、可重建);provider 只读它并 map 成 N 条 kind:"spot":
// value = amount × unitPrice、price = unitPrice(P7.4.1)。`amount` 由各 token 的 manual 活动账本
// (manual_activity 挂 token_id)推导后【物化】进 creds.tokens(app 层);provider 保持纯 / DB-free。
// 有 identifier → 产 coingecko: tokenRef 供 revalue 按显式 ref 解析;无则按 symbol 归一(同 CEX)。
// manual 统一走市价重估(ADR 0010 删 fixed)。零依赖、不碰 SECRETS_KEY/cloudflare:workers(原则 #5)。

// creds.tokens 的一项:token 定义 + 物化出的 amount(= 对应 token 活动账本的 deriveAmount)。
const manualToken = z.object({
  symbol: z.string().trim().min(1),
  unitPrice: z.coerce.number(),
  identifier: z.string().trim().min(1).optional(),
  amount: z.coerce.number(),
});

// —— 账户级 creds(AC):单个 public `tokens` 字段,承载 [{symbol,unitPrice,identifier?,amount}] ——
// 存库为 JSON 字符串(全 public、明文);validateCredentials 用本 validator 把串 parse + coerce 成 typed
// 数组。JSON 畸形 → 原样落回,数组校验失败 → CredentialValidationError(不裸抛 SyntaxError)。
// 账户 creds 声明随 provider(其天然消费者)落此;由 entry 的 manual connector 引入组合。
export const manualAccountCreds = [
  {
    key: "tokens",
    type: "public",
    label: "Tokens",
    validator: z.preprocess((v) => {
      if (typeof v !== "string") return v;
      try {
        return JSON.parse(v);
      } catch {
        return v; // → 交给 z.array 判负,报成 tokens 的校验错而非裸 throw
      }
    }, z.array(manualToken)),
  },
] as const satisfies readonly CredField[];

// 本 connector 只吐单一 kind:spot。无全局/provider key → creds:[]。
export const manualProvider: BalanceProvider<Spot, typeof manualAccountCreds> = {
  id: "manual",
  label: "Manual",
  creds: [],

  async fetchBalances(ctx): Promise<{ balances: Spot[] }> {
    const { tokens } = ctx.account.creds;
    return {
      balances: tokens.map((t) => ({
        symbol: t.symbol,
        amount: t.amount,
        price: t.unitPrice,
        value: t.amount * t.unitPrice,
        kind: "spot",
        // 用户选定的 CGK id = 厂商寻址身份 → tokenRef(coingecko/<id>);未选币则无标识,按 symbol 归一。
        ...(t.identifier
          ? // CGK coin id 规范为小写 kebab;归一在生产者这一侧做(oracle-ref 对不透明 id 原样透传)。
            { tokenRef: tokenRef.opaque("coingecko", t.identifier.toLowerCase()) }
          : {}),
      })),
    };
  },

  // 无外部源;creds 已由创建流/同步的 validateCredentials(account.creds) 校验过。
  async validateAccount(): Promise<boolean> {
    return true;
  },
};

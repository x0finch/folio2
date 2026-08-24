import { Effect } from "effect";
import { ConnectorRegistry } from "@/lib/server/connectors/registry";
import type { InputSpec } from "@/lib/server/creds";

// **connector 门票的替身。**
//
// 为什么要它:凭据校验的三条分支(形状不对 / 探活失败 / 上游抖了一下)在真门票上只能靠打真
// 上游触发 —— 那既慢又不可控,而这套清单里最该测的对抗条恰恰全在这三条上。替身把「探活给什么
// 答案」变成用例的入参。
//
// 替身**不用来伪造字段规格**:那份规格是加密塑形的依据(哪个字段该加密),用假的等于把
// `createAccount` 最该测的那半架空。要真规格的用例传 `specs`,不传就用真的那份。

/** 真门票 —— 目录与规格照旧,只有 `validate` 被换掉。 */
export const realRegistry = (): Promise<ConnectorRegistry> =>
  Effect.runPromise(Effect.provide(ConnectorRegistry, ConnectorRegistry.Default));

export interface FakeRegistryOptions {
  /** 探活/形状闸给什么答案。默认放行。 */
  readonly validate?: (
    connectorId: string,
    values: Record<string, string>,
    opts?: { liveness?: boolean; label?: string },
  ) => Effect.Effect<void, Error>;
  /** 覆盖字段规格(只在测「规格变了会怎样」时用)。 */
  readonly specs?: Partial<Record<string, InputSpec[]>>;
  /** 覆盖目录。 */
  readonly catalog?: Record<string, { label: string; logo: string }>;
}

/**
 * 拿真门票做底,只换掉指定的那几样。
 *
 * 记下每次 `validate` 的入参:「留空的可选字段有没有被过滤掉」这类用例要看的正是传进校验的
 * 那份 values,而不是最后落库的结果 —— 后者在探活失败的分支里根本不存在。
 */
export const fakeRegistry = async (
  options: FakeRegistryOptions = {},
): Promise<{ registry: ConnectorRegistry; validated: Array<Record<string, string>> }> => {
  const real = await realRegistry();
  const validated: Array<Record<string, string>> = [];
  const registry = {
    catalog: options.catalog ?? real.catalog,
    specs: options.specs ?? real.specs,
    validate: (
      connectorId: string,
      values: Record<string, string>,
      opts?: { liveness?: boolean; label?: string },
    ) => {
      validated.push({ ...values });
      return options.validate
        ? options.validate(connectorId, values, opts)
        : (Effect.void as Effect.Effect<void, Error>);
    },
  } as ConnectorRegistry;
  return { registry, validated };
};

/** 探活失败(用户看得见的那条错)。 */
export const validateFails = (message: string) => () =>
  Effect.fail(new Error(message)) as Effect.Effect<void, Error>;

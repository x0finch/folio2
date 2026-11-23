import { Effect } from "effect";
import type { Balance } from "./balance";
import type { BalanceProvider, FetchContext } from "./connector";
import { fromProviderError } from "./connector-error";
import type { CredField, CredsOf } from "./creds";
import type { Note } from "./note";

// Adapts a Promise-based provider (throwing `ProviderError`) to the Effect contract. Wrapping the
// whole provider keeps each call site to two lines and marks which providers aren't native yet.
export interface PromiseBalanceProvider<
  B extends Balance,
  AC extends readonly CredField[] = readonly CredField[],
  PC extends readonly CredField[] = readonly CredField[],
> extends Omit<BalanceProvider<B, AC, PC>, "fetchBalances" | "validateAccount"> {
  fetchBalances(
    ctx: FetchContext<CredsOf<AC>, CredsOf<PC>>,
  ): Promise<{ balances: B[]; note?: Note[] }>;
  validateAccount(ctx: FetchContext<CredsOf<AC>, CredsOf<PC>>): Promise<boolean>;
}

export function promiseProvider<
  B extends Balance,
  AC extends readonly CredField[] = readonly CredField[],
  PC extends readonly CredField[] = readonly CredField[],
>(provider: PromiseBalanceProvider<B, AC, PC>): BalanceProvider<B, AC, PC> {
  return {
    ...provider,
    fetchBalances: (ctx) =>
      Effect.tryPromise({ try: () => provider.fetchBalances(ctx), catch: fromProviderError }),
    validateAccount: (ctx) =>
      Effect.tryPromise({ try: () => provider.validateAccount(ctx), catch: fromProviderError }),
  };
}

import { Balance, type CredField } from "@folio/connectors-basic";
import {
  type BalanceUpstream,
  tierOf,
  type UpstreamError,
  UpstreamParseError,
  UpstreamRefusedError,
} from "@folio/upstream-basic";
import { Effect, Exit, Option, Schema } from "effect";
import type { BalanceCapability, BalanceTarget, Upstream } from "./define";

const ANY_STRING = Schema.toStandardSchemaV1(Schema.String);

// The env names the app injects, as the port's `creds`. Values are never validated here: a missing
// key surfaces as `auth` from `connect`.
const envCreds = (upstream: Upstream<string, string>): readonly CredField[] => {
  const plain = new Set<string>(upstream.publicKeys ?? []);
  const keys = new Set<string>(
    [...(upstream.keys ?? []), ...(upstream.optionalKeys ?? [])].filter((key) => !plain.has(key)),
  );
  // Anything else is a base override: public, so never encrypted or exported.
  return upstream.envNames.map(
    (key): CredField => ({
      key,
      type: keys.has(key) ? "secret" : "public",
      label: key,
      validator: ANY_STRING,
    }),
  );
};

// One line per call, by allowlist: upstream, capability, outcome tier and row count.
const outcomeOf = (exit: Exit.Exit<unknown, UpstreamError>): string => {
  if (Exit.isSuccess(exit)) return "ok";
  const error = Exit.findErrorOption(exit);
  return Option.isSome(error) ? tierOf(error.value) : "defect";
};

const logOutcome =
  (upstream: string, capability: string, countOf: (value: never) => number | undefined) =>
  <A, R>(effect: Effect.Effect<A, UpstreamError, R>): Effect.Effect<A, UpstreamError, R> =>
    Effect.onExit(effect, (exit) =>
      Effect.logDebug("upstream call").pipe(
        Effect.annotateLogs({
          upstream,
          capability,
          outcome: outcomeOf(exit),
          count: Exit.isSuccess(exit) ? countOf(exit.value as never) : undefined,
        }),
      ),
    );

// Rows must satisfy the shared balance contract; a row that doesn't means our parser drifted from
// the upstream, so the whole call is a parse failure rather than a half-written snapshot.
const checkRows = <B>(
  upstream: string,
  rows: readonly B[],
): Effect.Effect<void, UpstreamParseError> => {
  const bad = rows.findIndex((row) => !Balance.safeParse(row).success);
  return bad === -1
    ? Effect.void
    : Effect.fail(new UpstreamParseError({ upstream, where: "(output)", cause: `row ${bad}` }));
};

export function balanceUpstream<K extends string, O extends string, A, B extends Balance>(
  upstream: Upstream<K, O>,
  capability: BalanceCapability<K, O, A, B>,
): BalanceUpstream<B> {
  const decodeAccount = Schema.decodeUnknownEffect(capability.account);

  const prepare = (ctx: Parameters<BalanceUpstream<B>["fetchBalances"]>[0]) =>
    Effect.gen(function* () {
      const creds = yield* decodeAccount(ctx.account.creds).pipe(
        Effect.mapError(
          () =>
            new UpstreamRefusedError({
              upstream: upstream.id,
              where: "(account)",
              cause: `account creds don't fit ${upstream.id}`,
            }),
        ),
      );
      const call = yield* upstream.connect(ctx.creds, capability.base?.(creds));
      const target: BalanceTarget<A> = {
        accountId: ctx.account.id,
        connectorId: ctx.account.connectorId,
        creds,
      };
      return { call, target };
    });

  return {
    id: upstream.id,
    label: upstream.label,
    creds: envCreds(upstream as Upstream<string, string>),

    fetchBalances: (ctx) =>
      prepare(ctx).pipe(
        Effect.flatMap(({ call, target }) => capability.fetch(call, target)),
        Effect.tap(({ balances }) => checkRows(upstream.id, balances)),
        logOutcome(upstream.id, "balance", (out: { balances: unknown[] }) => out.balances.length),
      ),

    // Only rejected credentials (a missing deployment key included) mean `false`; anything else
    // stays an error so callers can retry.
    validateAccount: (ctx) =>
      prepare(ctx).pipe(
        Effect.flatMap(({ call, target }) => (capability.verify ?? capability.fetch)(call, target)),
        Effect.as(true),
        Effect.catchTag("UpstreamAuthError", () => Effect.succeed(false)),
        logOutcome(upstream.id, "verify", () => undefined),
      ),
  };
}

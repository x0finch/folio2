import type { Balance, Note } from "@folio/connectors-basic";
import type { UpstreamError, UpstreamNeeds } from "@folio/upstream-basic";
import { UpstreamAuthError } from "@folio/upstream-basic";
import { type Duration, Effect, type Schema } from "effect";
import { makeRequester, type Requester } from "./http";
import { make as makeRateLimit, type RateLimit } from "./ratelimit";

// What a quota is metered on, which decides who shares the bucket:
//   key        — one deployment API key (all users share it),
//   egress     — the Workers egress IP (keyless public endpoints),
//   deployment — the whole deployment regardless of key or IP (e.g. a signature the upstream meters).
type LimitScope = "key" | "egress" | "deployment";

interface Limit {
  readonly limit: number; // grants per window; also the burst
  readonly window: Duration.Input;
  readonly scope: LimitScope;
  // Applies only with / without the optional key (an upstream with a keyless tier).
  readonly when?: "keyed" | "keyless";
}

export interface UpstreamSpec<K extends string = string, O extends string = never> {
  readonly id: string; // lowercase slug; also the `upstream` field of every error it raises
  readonly label: string;
  readonly base: string;
  // Deployment env var that replaces `base` (a proxy for a geo-blocked egress, a local fake).
  readonly baseOverride?: string;
  // Deployment env var names. A missing required key fails with `auth` before any request.
  readonly keys?: readonly K[];
  readonly optionalKeys?: readonly O[];
  readonly userAgent?: string;
  // Headers on every request, from the resolved keys.
  readonly headers?: (keys: Keys<K, O>) => Record<string, string>;
  // `default` gates every request; others only requests sent through `call.via(name)`.
  readonly limits?: Readonly<Record<string, Limit>>;
  readonly rateLimitedStatuses?: readonly number[];
}

type Keys<K extends string, O extends string> = Readonly<Record<K, string>> &
  Readonly<Partial<Record<O, string>>>;

// Handed to a capability: requests already carry base, headers, gate and classification.
export interface Call<K extends string = string, O extends string = never> {
  readonly request: Requester;
  readonly via: (limit: string) => Requester;
  readonly keys: Keys<K, O>;
}

export interface BalanceTarget<A> {
  readonly accountId: string;
  readonly connectorId: string;
  readonly creds: A;
}

export interface BalanceCapability<K extends string, O extends string, A, B extends Balance> {
  // Decodes the account's stored creds; a mismatch means the account kind and upstream disagree.
  readonly account: Schema.Codec<A, unknown>;
  readonly fetch: (
    call: Call<K, O>,
    target: BalanceTarget<A>,
  ) => Effect.Effect<{ balances: B[]; note?: Note[] }, UpstreamError, UpstreamNeeds>;
  // The cheapest call that proves the account readable; defaults to `fetch`.
  readonly verify?: (
    call: Call<K, O>,
    target: BalanceTarget<A>,
  ) => Effect.Effect<unknown, UpstreamError, UpstreamNeeds>;
}

export interface Upstream<K extends string = string, O extends string = never>
  extends UpstreamSpec<K, O> {
  readonly connect: (
    env: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<Call<K, O>, UpstreamAuthError>;
  // Env names the app must inject: keys and the base override, never anything else.
  readonly envNames: readonly string[];
}

const stringOf = (env: Readonly<Record<string, unknown>>, name: string): string | undefined => {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

export function defineUpstream<const K extends string = never, const O extends string = never>(
  spec: UpstreamSpec<K, O>,
): Upstream<K, O> {
  const required = spec.keys ?? [];
  const optional = spec.optionalKeys ?? [];
  const envNames = [...required, ...optional, ...(spec.baseOverride ? [spec.baseOverride] : [])];

  const resolveKeys = (
    env: Readonly<Record<string, unknown>>,
  ): Effect.Effect<Keys<K, O>, UpstreamAuthError> => {
    const keys: Record<string, string> = {};
    for (const name of required) {
      const value = stringOf(env, name);
      if (!value) {
        return Effect.fail(
          new UpstreamAuthError({
            upstream: spec.id,
            where: "(config)",
            cause: `${name} not configured`,
          }),
        );
      }
      keys[name] = value;
    }
    for (const name of optional) {
      const value = stringOf(env, name);
      if (value) keys[name] = value;
    }
    return Effect.succeed(keys as Keys<K, O>);
  };

  const gateFor = (name: string, keyed: boolean): Effect.Effect<RateLimit | undefined> => {
    const limit = spec.limits?.[name];
    if (!limit) return Effect.succeed(undefined);
    if (limit.when === "keyed" && !keyed) return Effect.succeed(undefined);
    if (limit.when === "keyless" && keyed) return Effect.succeed(undefined);
    // Bucket names never hold a key's value: they end up in logs and cache URLs.
    return makeRateLimit({
      key: `${spec.id}:${name}:${limit.scope}`,
      limit: limit.limit,
      interval: limit.window,
    });
  };

  const connect = (env: Readonly<Record<string, unknown>>) =>
    Effect.gen(function* () {
      const keys = yield* resolveKeys(env);
      const keyed = optional.some((name) => name in keys) || required.length > 0;
      const baseUrl = (spec.baseOverride && stringOf(env, spec.baseOverride)) || spec.base;
      const fixed = {
        ...(spec.userAgent ? { "user-agent": spec.userAgent } : {}),
        ...spec.headers?.(keys),
      };
      const requesterFor = (limit: RateLimit | undefined): Requester =>
        makeRequester({
          baseUrl,
          upstream: spec.id,
          headers: () => Effect.succeed(fixed),
          limit,
          rateLimitedStatuses: spec.rateLimitedStatuses,
        });
      const names = Object.keys(spec.limits ?? {});
      const gates = new Map<string, Requester>();
      for (const name of names) gates.set(name, requesterFor(yield* gateFor(name, keyed)));
      const request = gates.get("default") ?? requesterFor(undefined);
      const via = (name: string): Requester => {
        const gated = gates.get(name);
        if (!gated) throw new Error(`${spec.id}: no limit named ${name}`);
        return gated;
      };
      return { request, via, keys } satisfies Call<K, O>;
    });

  return { ...spec, connect, envNames };
}

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

interface Limit<O extends string = string> {
  readonly limit: number; // grants per window; also the burst
  readonly window: Duration.Input;
  readonly scope: LimitScope;
  // Applies only with / without any optional key (an upstream with a keyless tier), or with the
  // named one (a paid tier behind its own key).
  readonly when?: "keyed" | "keyless" | O;
}

export interface UpstreamSpec<K extends string = string, O extends string = never> {
  readonly id: string; // lowercase slug; also the `upstream` field of every error it raises
  readonly label: string;
  // Absent when every account brings its own host (the capability's `base`).
  readonly base?: string;
  // Interchangeable nodes serving the same API; how to move between them is the upstream's call.
  readonly mirrors?: readonly string[];
  // Deployment env var that replaces `base` and every mirror (a proxy for a geo-blocked egress, a local fake).
  readonly baseOverride?: string;
  // The same API on other domains (binance's futures), each with its own override.
  readonly hosts?: Readonly<Record<string, Host>>;
  // Deployment env var names. A missing required key fails with `auth` before any request.
  readonly keys?: readonly K[];
  readonly optionalKeys?: readonly O[];
  // Optional keys that are settings, not secrets (e.g. the deployment's own origin).
  readonly publicKeys?: readonly O[];
  readonly userAgent?: string;
  // Headers on every request, from the resolved keys.
  readonly headers?: (keys: Keys<K, O>) => Record<string, string>;
  // `default` gates every request; others only requests sent through `call.via(name)`. A list is
  // tiers: the first whose `when` holds applies.
  readonly limits?: Readonly<Record<string, Limit<O> | readonly Limit<O>[]>>;
  readonly rateLimitedStatuses?: readonly number[];
  readonly refuseRedirects?: boolean;
  readonly maxBodyBytes?: number;
}

interface Host {
  readonly base: string;
  readonly baseOverride?: string;
}

type Keys<K extends string, O extends string> = Readonly<Record<K, string>> &
  Readonly<Partial<Record<O, string>>>;

// Handed to a capability: requests already carry base, headers, gate and classification.
export interface Call<K extends string = string, O extends string = never> {
  readonly request: Requester;
  readonly via: (limit: string) => Requester;
  // A named host from the spec, under the default limit.
  readonly host: (name: string) => Requester;
  // One requester per node, `base` first, under the default limit; just the override when set.
  readonly nodes: readonly Requester[];
  // The base requests go to (the override when set); scopes caches per endpoint.
  readonly base: string;
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
  // The account's own base URL, for an upstream whose host is user-configured.
  readonly base?: (creds: A) => string;
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
  // `accountBase` replaces `base`, any override and every mirror: the account names its own host.
  readonly connect: (
    env: Readonly<Record<string, unknown>>,
    accountBase?: string,
  ) => Effect.Effect<Call<K, O>, UpstreamAuthError>;
  // Env names the app must inject: keys and base overrides, never anything else.
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
  const hosts = Object.entries(spec.hosts ?? {});
  const overrides = [spec.baseOverride, ...hosts.map(([, host]) => host.baseOverride)].filter(
    (name) => name !== undefined,
  );
  // Hosts may share one override (a proxy in front of every domain).
  const envNames = [...new Set([...required, ...optional, ...overrides])];

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

  const gateFor = (name: string, keys: Keys<K, O>): Effect.Effect<RateLimit | undefined> => {
    const keyed = optional.some((key) => key in keys) || required.length > 0;
    const applies = ({ when }: Limit<O>) =>
      when === undefined || (when === "keyed" ? keyed : when === "keyless" ? !keyed : when in keys);
    const limit = [spec.limits?.[name] ?? []].flat().find(applies);
    if (!limit) return Effect.succeed(undefined);
    // Bucket names never hold a key's value: they end up in logs and cache URLs.
    return makeRateLimit({
      key: `${spec.id}:${name}:${limit.scope}`,
      limit: limit.limit,
      interval: limit.window,
    });
  };

  const basesFor = (env: Readonly<Record<string, unknown>>, accountBase?: string): string[] => {
    if (accountBase) return [accountBase];
    const override = spec.baseOverride && stringOf(env, spec.baseOverride);
    if (override) return [override];
    return spec.base ? [spec.base, ...(spec.mirrors ?? [])] : [];
  };

  const connect = (env: Readonly<Record<string, unknown>>, accountBase?: string) =>
    Effect.gen(function* () {
      const keys = yield* resolveKeys(env);
      const bases = basesFor(env, accountBase);
      if (bases.length === 0) return yield* Effect.die(new Error(`${spec.id}: no base to call`));
      const fixed = {
        ...(spec.userAgent ? { "user-agent": spec.userAgent } : {}),
        ...spec.headers?.(keys),
      };
      const requesterFor = (limit: RateLimit | undefined, baseUrl = bases[0]): Requester =>
        makeRequester({
          baseUrl,
          upstream: spec.id,
          headers: () => Effect.succeed(fixed),
          limit,
          rateLimitedStatuses: spec.rateLimitedStatuses,
          refuseRedirects: spec.refuseRedirects,
          maxBodyBytes: spec.maxBodyBytes,
        });
      const limits = new Map<string, RateLimit | undefined>();
      for (const name of Object.keys(spec.limits ?? {})) {
        limits.set(name, yield* gateFor(name, keys));
      }
      const gates = new Map<string, Requester>();
      for (const [name, limit] of limits) gates.set(name, requesterFor(limit));
      const request = gates.get("default") ?? requesterFor(undefined);
      const nodes = bases.map((base, i) =>
        i === 0 ? request : requesterFor(limits.get("default"), base),
      );
      const via = (name: string): Requester => {
        const gated = gates.get(name);
        if (!gated) throw new Error(`${spec.id}: no limit named ${name}`);
        return gated;
      };
      const hostRequesters = new Map(
        hosts.map(([name, h]) => [
          name,
          requesterFor(
            limits.get("default"),
            (h.baseOverride && stringOf(env, h.baseOverride)) || h.base,
          ),
        ]),
      );
      const host = (name: string): Requester => {
        const requester = hostRequesters.get(name);
        if (!requester) throw new Error(`${spec.id}: no host named ${name}`);
        return requester;
      };
      return { request, via, host, nodes, base: bases[0], keys } satisfies Call<K, O>;
    });

  return { ...spec, connect, envNames };
}

import { env } from "cloudflare:workers";
import {
  type ConnectorId,
  registry as connectorRegistry,
  getConnector,
  selectProvider,
  validateCredentials,
} from "@folio/connectors";
import { isRetryable, retryAfterOf, type UpstreamError } from "@folio/upstream-basic";
import { FolioHttpClient } from "@folio/upstreams";
import { Context, Duration, Effect, Layer, Schedule } from "effect";
import { platformLogoUrl } from "@/lib/core/logo";
import { type InputSpec, toInputSpec } from "@/lib/server/creds";

// Liveness-probe retry: much tighter than sync's (background, nobody waiting) because the user is watching the
// form. One retry only dodges transient blips; waits are capped at 1.5 s.
const VALIDATE_RETRY_ATTEMPTS = 2; // total attempts (1 + 1 retry)
const VALIDATE_RETRY_MAX_WAIT_MS = 1500;
const VALIDATE_RETRY_BASE_MS = 200;

// Not shared with `@folio/sync`'s `retryPolicy`.
const validateRetryPolicy = Schedule.exponential(Duration.millis(VALIDATE_RETRY_BASE_MS)).pipe(
  // ① Retry only retryable errors, and give up if the upstream's suggested wait exceeds our cap: clamping would likely
  //    hit 429 again, and surfacing the error beats a hung form (opposite of sync's clamp, deliberately).
  Schedule.while(({ input }: Schedule.Metadata<Duration.Duration, UpstreamError>) => {
    if (!isRetryable(input)) return false;
    const suggested = retryAfterOf(input);
    return suggested === undefined || suggested <= VALIDATE_RETRY_MAX_WAIT_MS;
  }),
  // ② Use the upstream's stated delay, else the exponential value; both clamped to the cap.
  Schedule.modifyDelay(({ input, duration }) => {
    const suggested = retryAfterOf(input);
    return Effect.succeed(
      Duration.min(
        Duration.millis(VALIDATE_RETRY_MAX_WAIT_MS),
        suggested !== undefined ? Duration.millis(suggested) : duration,
      ),
    );
  }),
  // ③ Jitter is required: callers on one key all wake at the same Retry-After and would collide again.
  //    Additive (+0..baseMs) because Effect's multiplicative `jittered` can undercut the base.
  Schedule.addDelay(() =>
    Effect.sync(() => Duration.millis(Math.random() * VALIDATE_RETRY_BASE_MS)),
  ),
  (backoff) => Schedule.max([backoff, Schedule.recurs(VALIDATE_RETRY_ATTEMPTS - 1)]),
);

// App-side connector dispatch hub (server-only: imports cloudflare:workers, so only referenced inside handler bodies;
// the server fn facade is ./connectors). Owns spec projection, creation-time credential validation and the catalog.
// Never touches SECRETS_KEY: it sees plaintext from the form and does only a shape gate + optional liveness probe;
// encryption lives in lib/server/creds.ts.

export interface ConnectorCatalogEntry {
  label: string;
  // Proxied: http images via /api/logo/platform/<cid>, manual data: URIs inline (platformLogoUrl); none -> undefined.
  logo?: string;
}

// connectorId -> {label, logo} over the registry (single source of truth). The logo is the manifest's image through
// the `platformLogoUrl` proxy (privacy); /api/logo/platform resolves venue / manual keys by connectorId.
const buildCatalog = (): Record<string, ConnectorCatalogEntry> => {
  const out: Record<string, ConnectorCatalogEntry> = {};
  for (const [cid, manifest] of connectorRegistry) {
    out[cid] = { label: manifest.label, logo: platformLogoUrl(cid, manifest.logo) };
  }
  return out;
};

// Serializable per-connector account input specs: the manifest's `account.creds` minus the non-serializable validator.
const buildSpecs = (): Partial<Record<ConnectorId, InputSpec[]>> => {
  const specs: Partial<Record<ConnectorId, InputSpec[]>> = {};
  for (const [cid, manifest] of connectorRegistry) {
    specs[cid as ConnectorId] = manifest.account.creds.map(toInputSpec);
  }
  return specs;
};

// Upstream errors are `Data.TaggedError` (already Error) and pass through; anything else is wrapped.
const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/** App-side connector service. Built once with no args; reads `env` at build time (not module load), and never touches SECRETS_KEY. Catalog and specs are pure projections of the registry. */
const makeRegistry = () => ({
  catalog: buildCatalog(),
  specs: buildSpecs(),

  // Whether stored secrets survive a change of the account's public creds (custom: same host).
  keepsSecrets: (
    connectorId: string,
    previous: Record<string, string>,
    next: Record<string, string>,
  ): boolean =>
    getConnector(connectorRegistry, connectorId)?.account.keepsSecrets?.(previous, next) ?? true,

  // Optional creds this account requires given its public ones.
  neededCreds: (connectorId: string, publicCreds: Record<string, string>): readonly string[] =>
    getConnector(connectorRegistry, connectorId)?.account.needs?.(publicCreds) ?? [],

  // Credential validation on create / completion: shape gate per `account.creds`, then (with opts.liveness)
  // `provider.validateAccount`. Failures are typed; the form shows the message verbatim.
  validate: (
    connectorId: string,
    values: Record<string, string>,
    opts?: { liveness?: boolean; label?: string },
  ): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      const manifest = getConnector(connectorRegistry, connectorId);
      if (!manifest) {
        return yield* Effect.fail(new Error(`no connector for connectorId ${connectorId}`));
      }

      // Shape gate: each CredField's Standard Schema (bad / missing -> CredentialValidationError).
      const validated = yield* Effect.tryPromise({
        try: () => validateCredentials(manifest.account.creds, values),
        catch: asError,
      });
      const missing = (manifest.account.needs?.(values) ?? []).filter((key) => values[key] == null);
      if (missing.length > 0) {
        const labels = missing.map(
          (key) => manifest.account.creds.find((f) => f.key === key)?.label ?? key,
        );
        return yield* Effect.fail(new Error(`${labels.join(", ")}: required by this config`));
      }
      if (!opts?.liveness) return;

      // A connector without providers (manual) has no liveness check; the shape gate already passed.
      // Declared providers that can't be selected is a config error and still fails.
      if (manifest.balance.providers.length === 0) return;
      const provider = selectProvider(manifest);
      if (!provider) {
        return yield* Effect.fail(new Error(`no provider for connector ${connectorId}`));
      }
      // Default creds come from env by the provider's declared keys (least privilege), same as sync's fetchViaConnector.
      const providerCreds: Record<string, string> = {};
      for (const f of provider.creds) {
        const v = (env as unknown as Record<string, string | undefined>)[f.key];
        if (v != null) providerCreds[f.key] = v;
      }
      const ctx = {
        account: { id: "new", label: opts.label ?? "", connectorId, creds: validated },
        creds: providerCreds,
      };
      // One retry for the probe: this path bypasses @folio/sync, so a transient 429 / 5xx would show "add failed"
      // for correct input. No rate gate: a spinner is worse than "retry", and probes are single shots.
      // Only unreachable-upstream errors retry: `validateAccount` returns `false` for rejected credentials and uses the
      // error channel for transport failures, so a wrong key reports "could not verify" without re-hitting upstream.
      // Pinned by tests/server/validate-retry.test.ts. Uses the same `isRetryable` as `@folio/sync`.
      const alive = yield* provider.validateAccount(ctx).pipe(
        Effect.retry(validateRetryPolicy),
        Effect.provide(FolioHttpClient),
        // A config the upstream refuses (custom source) is the user's to fix: its reason is our
        // own text, never upstream content, so it can reach the form.
        Effect.mapError((e) =>
          e._tag === "UpstreamRefusedError" && e.where === "(config)" && e.cause
            ? new Error(e.cause)
            : asError(e),
        ),
      );
      if (!alive) {
        return yield* Effect.fail(
          new Error("could not verify these credentials — please check them and try again"),
        );
      }
    }),
});

export class ConnectorRegistry extends Context.Service<ConnectorRegistry>()(
  "web/ConnectorRegistry",
  { make: Effect.sync(makeRegistry) },
) {
  static readonly layer = Layer.effect(this, this.make);
}

/** The same ticket as a Context built without Layer, for `runtime.ts`'s hand-assembled runtime. */
export const connectorRegistryContext = (): Context.Context<ConnectorRegistry> =>
  Context.make(ConnectorRegistry, ConnectorRegistry.of(makeRegistry()));

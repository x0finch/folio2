import { Balance, type CredField } from "@folio/connectors-basic";
import type { UpstreamError, UpstreamNeeds } from "@folio/upstream-basic";
import { Cause, Effect, Layer, Logger, References, Tracer } from "effect";
import { describe, expect, it } from "vitest";
import {
  type HttpClientRequestLike,
  type HttpStub,
  httpStub,
  jsonResponse,
  runClient,
} from "../../src/runtime/testing";

type Reply = (request: HttpClientRequestLike) => Response | Promise<Response>;

export const RETRY_AFTER_SECONDS = 3;

// The failure replies every upstream must classify the same way.
export const replies = {
  status:
    (status: number): Reply =>
    () =>
      jsonResponse({ error: "nope" }, { status }),
  rateLimited: (): Response =>
    jsonResponse(
      { error: "slow down" },
      { status: 429, headers: { "retry-after": String(RETRY_AFTER_SECONDS) } },
    ),
  offline: (): Response => {
    throw new Error("connection reset");
  },
  garbage: (): Response =>
    new Response("<html>not json</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
} satisfies Record<string, Reply | ((status: number) => Reply)>;

// Everything a span or a log line could carry, flattened to strings so a secret can be searched
// for. Exits and causes are included: an error's `cause` is where leaks have happened before.
export const recorder = () => {
  const spans: Tracer.NativeSpan[] = [];
  const logs: string[] = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const logger = Logger.make(({ message, cause, fiber }) => {
    logs.push(
      safeJson(message),
      Cause.pretty(cause),
      safeJson(fiber.getRef(References.CurrentLogAnnotations)),
    );
  });
  const layer = Layer.mergeAll(
    Layer.succeed(Tracer.Tracer, tracer),
    Logger.layer([logger]),
    Layer.succeed(References.MinimumLogLevel, "All"),
  );
  const spanNames = () => spans.map((span) => span.name);
  const recorded = (): string[] => [
    ...logs,
    ...spans.flatMap((span) => [
      span.name,
      safeJson(Object.fromEntries(span.attributes)),
      safeJson(span.events),
      safeJson(span.status),
    ]),
  ];
  return { layer, logs, spanNames, recorded };
};

export const safeJson = (value: unknown): string =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)) ?? String(value);

export const expectNoSecret = (recorded: readonly string[], secrets: readonly string[]) => {
  // A key sent as an HTTP Basic username only ever appears encoded.
  for (const secret of [...secrets, ...secrets.map((plain) => btoa(`${plain}:`))]) {
    const hit = recorded.find((line) => line.includes(secret));
    expect(hit, `secret leaked: ${secret}`).toBeUndefined();
  }
};

// Structural so every upstream's own creds typing fits.
interface BalancePort {
  readonly id: string;
  readonly creds: readonly CredField[];
  fetchBalances(ctx: never): Effect.Effect<{ balances: Balance[] }, UpstreamError, UpstreamNeeds>;
  validateAccount(ctx: never): Effect.Effect<boolean, UpstreamError, UpstreamNeeds>;
}

export interface BalanceSubject {
  readonly port: BalancePort;
  readonly account: { readonly connectorId: string; readonly creds: Record<string, unknown> };
  // Deployment env as the app injects it, secrets included.
  readonly env?: Readonly<Record<string, string>>;
  // Env keys whose absence must fail as `auth` before any request.
  readonly requiredKeys?: readonly string[];
  // Account creds that must never be recorded (deployment secrets are found from `port.creds`).
  readonly accountSecrets?: readonly string[];
  // Answers every endpoint `fetchBalances` and `validateAccount` hit, from recorded fixtures.
  readonly reply: Reply;
  // Services the upstream needs besides `HttpClient` (rabby's signer).
  readonly provide?: <A, E>(
    effect: Effect.Effect<A, E, UpstreamNeeds>,
  ) => Effect.Effect<A, E, UpstreamNeeds>;
}

export function balanceContract(name: string, subject: BalanceSubject): void {
  const env = subject.env ?? {};
  const ctx = (creds: Record<string, string> = { ...env }): never =>
    ({
      account: { id: "contract", label: name, ...subject.account },
      creds,
    }) as never;
  const fetch = (creds?: Record<string, string>) => subject.port.fetchBalances(ctx(creds));
  const verify = (creds?: Record<string, string>) => subject.port.validateAccount(ctx(creds));

  // The gate scope is `none`: rate gating has its own tests, and a spent `memory` bucket would wait
  // on a `TestClock` nothing moves.
  const run = <A, E>(stub: HttpStub, effect: Effect.Effect<A, E, UpstreamNeeds>) =>
    runClient(stub, (subject.provide ?? ((e) => e))(effect), "none");
  const failure = (reply: Reply, effect: Effect.Effect<unknown, UpstreamError, UpstreamNeeds>) =>
    run(httpStub(reply), Effect.flip(effect));

  const deploymentSecrets = subject.port.creds
    .filter((field) => field.type === "secret")
    .map((field) => env[field.key])
    .filter((value) => value !== undefined);
  const secrets = [...deploymentSecrets, ...(subject.accountSecrets ?? [])];

  describe(`${name}: balance contract`, () => {
    it("names itself after the upstream", () => {
      expect(subject.port.id).toBe(name);
    });

    it("happy path: non-empty rows that each pass the Balance contract", async () => {
      const { balances } = await run(httpStub(subject.reply), fetch());
      expect(balances.length).toBeGreaterThan(0);
      for (const row of balances) expect(Balance.safeParse(row).success).toBe(true);
    });

    it.each([401, 403])("%i gives auth", async (status) => {
      expect((await failure(replies.status(status), fetch()))._tag).toBe("UpstreamAuthError");
    });

    it("429 gives rate-limited, carrying Retry-After", async () => {
      const error = await failure(replies.rateLimited, fetch());
      expect(error._tag).toBe("UpstreamRateLimitError");
      expect(error._tag === "UpstreamRateLimitError" && error.retryAfterMs).toBe(
        RETRY_AFTER_SECONDS * 1000,
      );
    });

    it("503 and a network failure give unavailable", async () => {
      expect((await failure(replies.status(503), fetch()))._tag).toBe("UpstreamUnavailableError");
      expect((await failure(replies.offline, fetch()))._tag).toBe("UpstreamUnavailableError");
    });

    it("a 200 with an unreadable body gives parse", async () => {
      expect((await failure(replies.garbage, fetch()))._tag).toBe("UpstreamParseError");
    });

    it("declares every required key as a secret", () => {
      const declared = subject.port.creds.filter((f) => f.type === "secret").map((f) => f.key);
      for (const key of subject.requiredKeys ?? []) expect(declared).toContain(key);
    });

    for (const key of subject.requiredKeys ?? []) {
      it(`without ${key}: auth, and no request sent`, async () => {
        const { [key]: _, ...rest } = env;
        const stub = httpStub(subject.reply);
        const error = await run(stub, Effect.flip(fetch(rest)));
        expect(error._tag).toBe("UpstreamAuthError");
        expect(await run(stub, verify(rest))).toBe(false);
        expect(stub.calls).toHaveLength(0);
      });
    }

    it("validateAccount: true on success, false on 401", async () => {
      expect(await run(httpStub(subject.reply), verify())).toBe(true);
      expect(await run(httpStub(replies.status(401)), verify())).toBe(false);
    });

    it("validateAccount: anything but auth stays in the error channel", async () => {
      const cases: [Reply, UpstreamError["_tag"]][] = [
        [replies.status(503), "UpstreamUnavailableError"],
        [replies.rateLimited, "UpstreamRateLimitError"],
        [replies.offline, "UpstreamUnavailableError"],
        [replies.garbage, "UpstreamParseError"],
      ];
      for (const [reply, tag] of cases) expect((await failure(reply, verify()))._tag).toBe(tag);
    });

    // Keyless upstreams hold nothing to leak.
    it.runIf(secrets.length > 0)("no secret reaches a span, a log line or an error", async () => {
      const capture = recorder();
      const recorded = <A, E>(effect: Effect.Effect<A, E, UpstreamNeeds>) =>
        Effect.provide(effect, capture.layer);
      await run(httpStub(subject.reply), recorded(fetch()));
      await run(httpStub(subject.reply), recorded(verify()));
      const errors = await Promise.all(
        [replies.status(401), replies.status(503), replies.offline, replies.garbage].map((reply) =>
          run(httpStub(reply), recorded(Effect.flip(fetch()))),
        ),
      );

      // Proves the capture is wired: an empty record would pass vacuously.
      expect(capture.spanNames()).toContain("http.client.request");
      expect(capture.logs.join("\n")).toContain("upstream call");
      expectNoSecret([...capture.recorded(), ...errors.map((e) => safeJson(e))], secrets);
    });
  });
}

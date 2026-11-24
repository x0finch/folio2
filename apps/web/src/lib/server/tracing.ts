import { getLogger } from "@logtape/logtape";
import { Effect, Layer, Option, Tracer } from "effect";

// Per-request span tree: `Effect.fn` names get durations, printed as one debug log line.
//
// Hand-rolled instead of OTLP: an exporter needs a collector endpoint and auth, which a
// self-hosted single-user deploy doesn't have. Cross-request aggregation and flame graphs are
// out of scope; swapping this tracer for an OTLP one later needs no change in traced code.
//
// Installed only when LOG_LEVEL is debug. Building the tree costs CPU on every request (free
// plan: 10 ms) and is discarded at the default level. The gate asks LogTape itself, so it can't
// disagree with the level parsed in entry/log.ts.
//
// Not `Effect.withTracerEnabled(false)`: measured no CPU saving (Effect's `addSpanStackTrace`
// runs regardless of the switch), and no-op spans cut the parent chain, so `Cause.pretty` loses
// the handler name that `requireAuth`'s fallback log relies on.
const log = getLogger(["folio", "web", "trace"]);

interface Recorded {
  readonly name: string;
  readonly depth: number;
  readonly startNs: bigint;
  /** Set by `Effect.annotateSpans`; printed on the root row only. */
  readonly attributes: Map<string, unknown>;
  endNs?: bigint;
}

const msOf = (ns: bigint): string => (Number(ns) / 1_000_000).toFixed(1);

/** One collector per request: built by `spanTracer` on provide, gone when the request ends. */
const makeCollector = (emit: (tree: string) => void) => {
  const rows: Recorded[] = [];
  const depthOf = new WeakMap<object, number>();

  const flush = () => {
    // Root span ended: the tree is complete. Rows are in start order; indentation is parent/child.
    emit(
      rows
        .map((r) => {
          const took = r.endNs ? msOf(r.endNs - r.startNs) : "?";
          // Root-only: the userId is a tree-wide attribute, repeating it per row is noise.
          const attrs =
            r.depth === 0 && r.attributes.size > 0
              ? ` ${[...r.attributes].map(([k, v]) => `${k}=${String(v)}`).join(" ")}`
              : "";
          return `${"  ".repeat(r.depth)}${r.name} ${took}ms${attrs}`;
        })
        .join("\n"),
    );
    rows.length = 0;
  };

  return { rows, depthOf, flush };
};

type Collector = ReturnType<typeof makeCollector>;

const tracerOf = (c: Collector): Tracer.Tracer =>
  Tracer.make({
    span(options) {
      const depth = Option.match(options.parent, {
        onNone: () => 0,
        onSome: (p) => (c.depthOf.get(p) ?? 0) + 1,
      });
      const row: Recorded = {
        name: options.name,
        depth,
        startNs: options.startTime,
        attributes: new Map(),
      };
      c.rows.push(row);
      const span = new Tracer.NativeSpan(options);
      const setAttribute = span.attribute.bind(span);
      span.attribute = (key, value) => {
        row.attributes.set(key, value);
        setAttribute(key, value);
      };
      const finish = span.end.bind(span);
      span.end = (endTime, exit) => {
        (row as { endNs?: bigint }).endNs = endTime;
        finish(endTime, exit);
        if (depth === 0) c.flush();
      };
      c.depthOf.set(span, depth);
      return span;
    },
  });

/** `emit` is injectable only so unit tests can capture the tree. */
export const spanTracerTo = (emit: (tree: string) => void): Layer.Layer<never> =>
  Layer.unwrap(Effect.sync(() => Layer.succeed(Tracer.Tracer, tracerOf(makeCollector(emit)))));

const spanTracer: Layer.Layer<never> = spanTracerTo((tree) =>
  log.debug("span tree\n{tree}", { tree }),
);

/** Wraps `runForUser` and cron's `runAtEdge`; installs the tree only when debug will be logged. */
export const withSpanTree = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  log.isEnabledFor("debug") ? Effect.provide(effect, spanTracer) : effect;

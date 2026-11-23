// Each vitest file re-evaluates the whole app import graph in workerd (~9s/file) and this pool has
// no shared module graph, so cases live in per-handler `.cases.ts` files aggregated here.
import "./data-stats.cases";
import "./data-version.cases";
import "./provider-keys.cases";
import "./valuation.cases";

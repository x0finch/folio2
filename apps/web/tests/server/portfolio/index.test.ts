// Each vitest file re-evaluates the whole app import graph in workerd (~9s/file) and this pool has
// no shared module graph, so cases live in per-handler `.cases.ts` files aggregated here.
import "./account-holdings.cases";
import "./endpoint-gain.cases";
import "./get-history.cases";
import "./overview.cases";
import "./scope.cases";
import "./snapshots.cases";
import "./tabs.cases";

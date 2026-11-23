// Each vitest file re-evaluates the whole app import graph in workerd (~9s/file) and this pool has
// no shared module graph, so cases live in per-handler `.cases.ts` files aggregated here.
import "./create.cases";
import "./delete.cases";
import "./list.cases";
import "./memberships.cases";
import "./move-account.cases";
import "./rename.cases";
import "./set-default.cases";

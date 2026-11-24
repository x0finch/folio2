// Each vitest file re-evaluates the whole app import graph in workerd (~9s/file) and this pool has
// no shared module graph, so cases live in per-handler `.cases.ts` files aggregated here.
import "./create.cases";
import "./credentials.cases";
import "./history.cases";
import "./list.cases";
import "./archive.cases";
import "./remove.cases";
import "./rename.cases";

// Each vitest file re-evaluates the whole app import graph in workerd (~9s/file; migrations are only 22ms) and this pool
// version (0.16.x) has no shared-module-graph knob, so the only lever is fewer files. Cases live one `.cases.ts` per handler
// and are pulled in here; each file's hooks are scoped to its own describe.
import "./create.cases";
import "./delete.cases";
import "./update-target.cases";

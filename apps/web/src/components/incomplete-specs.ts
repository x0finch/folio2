import type { InputSpec } from "@/lib/server/creds";
// Fields the re-entry form asks for: the non-public ones (semi + secret), plus any required public
// field missing from `known` (the account's safe view), e.g. after a partial import. Order preserved.
export function incompleteSpecs(
  specs: readonly InputSpec[],
  known: Readonly<Record<string, unknown>> = {},
): InputSpec[] {
  return specs.filter((s) => s.type !== "public" || (!s.optional && known[s.key] == null));
}

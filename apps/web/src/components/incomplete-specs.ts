import type { InputSpec } from "@/lib/server/creds";
// Fields the re-entry form asks for: the non-public ones (semi + secret), plus any public field the
// account still needs (`missing`), e.g. after a partial import. Order preserved.
export function incompleteSpecs(
  specs: readonly InputSpec[],
  missing: readonly string[] = [],
): InputSpec[] {
  return specs.filter((s) => s.type !== "public" || missing.includes(s.key));
}

import type { InputSpec } from "@/lib/server/creds";
// Fields the re-entry form asks for: the non-public ones (semi + secret) that creds `isComplete`
// gates on. Public fields come with real values on import. Order preserved.
export function incompleteSpecs(specs: readonly InputSpec[]): InputSpec[] {
  return specs.filter((s) => s.type !== "public");
}

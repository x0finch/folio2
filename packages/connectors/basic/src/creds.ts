import type { StandardSchemaV1 } from "@standard-schema/spec";

// Exposure level (all creds are stored encrypted at rest; this only governs export/input):
//   public = kept whole (e.g. address); semi = kept masked (e.g. apiKey); secret = dropped.
export type CredFieldType = "public" | "semi" | "secret";

export interface CredField<T = unknown> {
  readonly key: string;
  readonly type: CredFieldType;
  readonly validator: StandardSchemaV1<unknown, T>;
  // Doubles as the i18n key; falls back to English. Same for `desc`.
  readonly label: string;
  readonly desc?: string;
}

export type CredsOf<C extends readonly CredField[]> = {
  readonly [E in C[number] as E["key"]]: E extends CredField<infer T> ? T : never;
};

export function secretKeys(fields: readonly CredField[]): string[] {
  return fields.filter((f) => f.type === "secret").map((f) => f.key);
}
export function semiKeys(fields: readonly CredField[]): string[] {
  return fields.filter((f) => f.type === "semi").map((f) => f.key);
}
export function publicKeys(fields: readonly CredField[]): string[] {
  return fields.filter((f) => f.type === "public").map((f) => f.key);
}

// Deterministic, recognisable mask that keeps a few chars at each end.
export function maskCredential(value: string): string {
  if (!value) return "";
  if (value.length <= 6) return "…";
  const head = value.length >= 12 ? 4 : 2;
  const tail = value.length >= 12 ? 4 : 2;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export class CredentialValidationError extends Error {}

// Inputs are always strings (form or decrypted creds); validators coerce to their output type.
// Returns only declared fields; throws on the first invalid one.
export async function validateCredentials(
  fields: readonly CredField[],
  values: Record<string, string>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    let result = field.validator["~standard"].validate(values[field.key]);
    if (result instanceof Promise) result = await result;
    if (result.issues) {
      const msg = result.issues.map((iss) => iss.message).join("; ");
      throw new CredentialValidationError(`${field.key}: ${msg}`);
    }
    out[field.key] = result.value;
  }
  return out;
}

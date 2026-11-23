import { decrypt, encrypt, maskCredential } from "@folio/connectors-basic";

export interface InputSpec {
  key: string;
  type: "public" | "semi" | "secret";
  label: string;
  desc?: string;
}

// Stored creds map: only `secret` fields are encrypted; `public` / `semi` are plaintext.
// SEMI_PREFIX keys hold the masked fragment of a semi field on an imported account awaiting credentials.
export const SEMI_PREFIX = "semi_";

// Returns null (never throws) on corrupt JSON or a non-object, so one bad row doesn't take down
// a whole page; callers treat null as "no credentials" and the user re-enters them.
export function readStoredCreds(raw: string | null | undefined): Record<string, string> | null {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}

export async function sealCreds(
  specs: readonly InputSpec[],
  values: Record<string, string>,
  key: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const spec of specs) {
    const v = values[spec.key];
    if (v == null) continue;
    out[spec.key] = spec.type === "secret" ? await encrypt(v, key) : v;
  }
  return out;
}

export async function openCreds(
  specs: readonly InputSpec[],
  stored: Record<string, string>,
  key: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const spec of specs) {
    const v = stored[spec.key];
    if (v == null) continue;
    out[spec.key] = spec.type === "secret" ? await decrypt(v, key) : v;
  }
  return out;
}

// No key needed: public as-is, semi masked, secret dropped.
export function safeView(
  specs: readonly InputSpec[],
  stored: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of specs) {
    if (spec.type === "public") {
      if (stored[spec.key] != null) out[spec.key] = stored[spec.key];
    } else if (spec.type === "semi") {
      const v = stored[spec.key];
      if (v != null) out[spec.key] = maskCredential(v);
      else {
        const placeholder = stored[SEMI_PREFIX + spec.key];
        if (placeholder != null) out[spec.key] = placeholder;
      }
    }
  }
  return out;
}

export function isComplete(specs: readonly InputSpec[], stored: Record<string, string>): boolean {
  return specs.filter((s) => s.type !== "public").every((s) => stored[s.key] != null);
}

export function categorizeFields(specs: readonly InputSpec[]): {
  public: string[];
  semi: string[];
  secret: string[];
} {
  const keysOf = (t: InputSpec["type"]) => specs.filter((s) => s.type === t).map((s) => s.key);
  return { public: keysOf("public"), semi: keysOf("semi"), secret: keysOf("secret") };
}

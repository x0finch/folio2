export function deriveDefaultName(email: string): string {
  return email.trim().split("@")[0];
}

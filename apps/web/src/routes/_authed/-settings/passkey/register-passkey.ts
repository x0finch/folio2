import { authClient } from "@/lib/core/auth-client";
import { detectDeviceLabel } from "./passkey-authenticators";

/**
 * Writes the device name in a separate `updatePasskey` call: better-auth's `addPasskey({ name })`
 * also uses `name` as the WebAuthn `userName`, so two accounts on one machine would show up as
 * identical entries in the system passkey picker. updatePasskey needs no ceremony or fresh session.
 *
 * @param authenticatorAttachment "platform" = local authenticators only (no cross-device QR). Idle
 *   lock requires it; plain sign-in passkeys leave it open so security keys work.
 */
export async function registerPasskey(authenticatorAttachment?: "platform") {
  const res = await authClient.passkey.addPasskey(
    authenticatorAttachment ? { authenticatorAttachment } : {},
  );
  // A failed rename isn't a failed registration: the list falls back to the authenticator name.
  if (res?.data) {
    await authClient.passkey
      .updatePasskey({ id: res.data.id, name: detectDeviceLabel(navigator.userAgent) })
      .catch(() => null);
  }
  return res;
}

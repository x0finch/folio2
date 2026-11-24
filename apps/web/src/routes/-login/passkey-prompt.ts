// "Don't ask again" is per device (localStorage), since passkeys are registered per device.

const PASSKEY_PROMPT_DISMISSED_KEY = "folio_passkey_prompt_dismissed";

export function shouldPromptForPasskey(opts: {
  supported: boolean;
  dismissed: boolean;
  passkeyCount: number;
}): boolean {
  return opts.supported && !opts.dismissed && opts.passkeyCount === 0;
}

export function isPasskeyPromptDismissed(): boolean {
  try {
    return localStorage.getItem(PASSKEY_PROMPT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissPasskeyPrompt(): void {
  try {
    localStorage.setItem(PASSKEY_PROMPT_DISMISSED_KEY, "1");
  } catch {
    // Storage unavailable (private mode): we'll just ask again next time.
  }
}

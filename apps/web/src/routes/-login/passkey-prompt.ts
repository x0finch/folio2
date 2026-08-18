// 登录后「要不要引导加 passkey」的判定 + 每设备「别再问我」持久化(见 ADR 0028 / #285)。
// 判定是纯函数(可单测);「别再问我」存 localStorage —— passkey 本就每设备注册,某设备关掉不该
// 波及其它设备,故按设备记而非用户级。localStorage 读写包 try/catch 防 SSR / 隐私模式抛错。

const PASSKEY_PROMPT_DISMISSED_KEY = "folio_passkey_prompt_dismissed";

// 引导条件:浏览器支持 WebAuthn + 本设备未「别再问我」+ 该用户还没有任何 passkey。
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
    // 隐私模式 / storage 不可用:降级为「本次不记」,下次仍会问 —— 可接受
  }
}

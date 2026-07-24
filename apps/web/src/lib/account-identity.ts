// 账户卡身份派生(grill Q4):把「主行/副行/首字母」从 better-auth 的 user 一处算出。
// 「自托管」是本地化文案,不进纯函数 → secondary 用 kind 判别,UI 侧映射到 i18n。

export interface AccountUser {
  name?: string | null;
  email?: string | null;
}

type AccountSecondary = { kind: "email"; value: string } | { kind: "selfHosted" };

export interface AccountIdentity {
  primary: string;
  secondary: AccountSecondary;
  initial: string;
}

function clean(v: string | null | undefined): string {
  return (v ?? "").trim();
}

export function accountIdentity(user: AccountUser): AccountIdentity {
  const name = clean(user.name);
  const email = clean(user.email);
  const primary = name || email || "?";
  // 有 name 时副行才让位给 email;否则(name 缺、email 已上主行)副行显「自托管」。
  const secondary: AccountSecondary =
    name && email ? { kind: "email", value: email } : { kind: "selfHosted" };
  const initial = primary.charAt(0).toUpperCase() || "?";
  return { primary, secondary, initial };
}

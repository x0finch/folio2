// 从 email 派生默认显示名:取 @ 前的本地部分(两侧空白先裁)。
// 用作注册页 Name 输入框的 placeholder + 未填时的兜底值,衔接 S1 accountIdentity 的身份派生。
export function deriveDefaultName(email: string): string {
  return email.trim().split("@")[0];
}

// 列表项:仅取渲染需要的字段(listUserPasskeys 返回的 Passkey 还含 publicKey 等,此处用不到)。
export interface PasskeyRow {
  id: string; // better-auth 那行的主键 —— 重命名/删除接口收的是它
  credentialID: string; // WebAuthn 凭据 id —— 本机标记存的是它(见 idle-lock.ts),两者别混
  name?: string | null;
  createdAt: string | Date; // fetch 反序列化后可能是 string,渲染时统一 new Date()
  aaguid?: string | null; // 认证器型号标识 → 友好名
  backedUp?: boolean | null; // 是否云同步
  transports?: string | null; // 传输方式(internal/hybrid/usb…)→ 类型判定
}

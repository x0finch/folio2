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

// better-auth 的 error 是联合类型,只有部分分支带 code → 统一在这里取,免得每处都 in 判断一遍。
export function errorCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? String(err.code) : undefined;
}

/**
 * 注册 passkey 要求 session「新鲜」(better-auth 默认 freshAge = 1 天),而我们的 session 活 7 天
 * (`expiresIn`),于是登录满一天后所有添加动作一律 403「Session is not fresh」。
 *
 * **不把这个检查关掉**(`session.freshAge: 0`):它防的是 session 被偷之后悄悄挂一条 passkey 长期
 * 驻留。正确回应是让用户当场重新证明身份:验证一次不查 freshness,成功后服务端会重建 session。
 */
export const SESSION_NOT_FRESH = "SESSION_NOT_FRESH";

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

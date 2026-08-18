import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";

// 前端认证客户端。baseURL 省略 → 默认取当前 origin(dev/prod 通用),
// 请求打到 routes/api/auth/$.ts。仅用于 UX(登录/注册/登出/passkey/读 session);
// 数据安全边界仍是各 authedServerFn(见 require-auth.ts)。
// passkeyClient:提供 signIn.passkey(含 conditional-UI autoFill)+ passkey.addPasskey/
// listUserPasskeys/updatePasskey/deletePasskey(见 ADR 0028)。
export const authClient = createAuthClient({ plugins: [passkeyClient()] });

export const { signIn, signUp, signOut } = authClient;

import { createAuthClient } from "better-auth/react";

// 前端认证客户端。baseURL 省略 → 默认取当前 origin(dev/prod 通用),
// 请求打到 routes/api/auth/$.ts。仅用于 UX(登录/注册/登出/读 session);
// 数据安全边界仍是各 authedServerFn(见 require-auth.ts)。
const authClient = createAuthClient();

export const { signIn, signUp, signOut } = authClient;

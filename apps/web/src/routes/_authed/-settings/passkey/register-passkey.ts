import { authClient } from "../../../../lib/core/auth-client";
import { detectDeviceLabel } from "./passkey-authenticators";

/**
 * 注册一条 passkey,并把「添加时这台设备」的名字补写到列表用的 name 上。
 *
 * **为什么分两步、而不是注册时直接传 name**:better-auth 的 `addPasskey({ name })` 只有一个参数,
 * 却同时喂了两个地方 —— passkey 表的 `name` 列(设置页列表显示的设备名),以及 WebAuthn 的
 * `userName`(系统钥匙串里显示的**账户名**):
 *
 * ```
 * userName: ctx.query?.name || user.name || user.id
 * ```
 *
 * 传设备名进去,系统钥匙串就把这条凭据标成「Chrome on macOS」而不是账号名。一个人注册了两个 folio
 * 账号、都在同一台机器上加了 passkey,登录页点「用 passkey 登录」时系统列出的两条**长得一模一样**,
 * 没法分辨哪条是哪个账号(登录时服务端不设 allowCredentials,列表就是靠这个名字给人看的)。
 *
 * 所以注册时不传,让 `userName` 回落到 `user.name`(注册时收集,空则从 email 派生);拿到凭据后再单独
 * `updatePasskey` 写设备名。`updatePasskey` 不跑 ceremony、也不要求 fresh session,不会多问一次指纹。
 *
 * @param authenticatorAttachment 限定 "platform" = 只收本机认证器,不给「用其他设备」的二维码。
 *   闲置锁那条必须限定(凭据得落在这台设备的钥匙串里才解得开);纯登录用的添加不限,好让硬件安全
 *   钥匙也有入口。
 */
export async function registerPasskey(authenticatorAttachment?: "platform") {
  const res = await authClient.passkey.addPasskey(
    authenticatorAttachment ? { authenticatorAttachment } : {},
  );
  // 改名失败不算注册失败:凭据已经建好了,列表顶多退回显示认证器型号名(getAuthenticatorName)。
  if (res?.data) {
    await authClient.passkey
      .updatePasskey({ id: res.data.id, name: detectDeviceLabel(navigator.userAgent) })
      .catch(() => null);
  }
  return res;
}

import { test as base } from "@playwright/test";
import {
  type AuthenticatorOptions,
  addAuthenticator,
  type VirtualAuthenticator,
} from "./authenticator";

/** 供 spec 里的 helper 函数当参数类型用(fixture 只能在 test 回调里拿到,helper 得显式接过去)。 */
export type AddAuth = (opts?: AuthenticatorOptions) => Promise<VirtualAuthenticator>;

interface Fixtures {
  /**
   * 建一个虚拟认证器,测试结束自动拆掉。
   *
   * **必须拆**:虚拟认证器挂在 browser 上,不是 context 上 —— 只关 context 清不掉它。攒够几个之后
   * ceremony 会在多个认证器之间选错,表现是「单个 spec 跑全过、整套跑某条莫名开不了锁」。
   * (实测:24 条一起跑时第 23 条挂,单跑那个 spec 8 条全过。)
   *
   * 做成工厂而不是普通 fixture,是因为不同测试要的认证器不一样(平台 / USB / 无 UV 能力),
   * 而 fixture 本身没法带参数。
   */
  addAuth: AddAuth;
}

export const test = base.extend<Fixtures>({
  addAuth: async ({ page }, use) => {
    const created: VirtualAuthenticator[] = [];
    await use(async (opts) => {
      const authenticator = await addAuthenticator(page, opts);
      created.push(authenticator);
      return authenticator;
    });
    // 页面还活着的时候拆(fixture teardown 早于 context 关闭),否则 CDP 调用会打空。
    for (const authenticator of created) {
      await authenticator.remove().catch(() => {});
    }
  },
});

export { expect } from "@playwright/test";

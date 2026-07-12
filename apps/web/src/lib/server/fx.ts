import { oracle } from "./oracle";

// FX 汇率门面经统一 Oracle 装配(#79)。读走 resolve(cache-only,软过期返最近值),写走 warm(sync 后,全局)。

// sync 后预热(全局、与用户无关):SUPPORTED 币种任一缺失/过期则一次刷新整表。
export async function warmFx(): Promise<void> {
  await oracle.fx.warm();
}

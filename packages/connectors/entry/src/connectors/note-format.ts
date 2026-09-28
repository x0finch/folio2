// note 文案里的数字格式(三家 CEX 的 parse 共用)。
//
// **为什么不直接 `n.toLocaleString("en-US", { … })`**:带 options 的 `toLocaleString` 每调用一次就
// 现造一个 `Intl.NumberFormat`(V8 只缓存不带 options 的那一种)。一个锁仓多的币安账户一次同步要
// 格式化上百次,本机 profile 里单这一个函数就吃掉约 15ms CPU —— 免费计划一次调用只有 10ms
// (FOL-83 第二轮)。这里每种格式只造一个 formatter,输出逐字相同(`toLocaleString` 按规范就是
// 拿同样的 locale / options 造一个 `NumberFormat` 再 `format`)。
//
// **惰性**:第一次用到才造,不在模块加载期 —— Workers 的启动 CPU 限制(CLAUDE.md)。

const lazyFormat = (options: Intl.NumberFormatOptions) => {
  let formatter: Intl.NumberFormat | undefined;
  return (n: number): string => {
    formatter ??= new Intl.NumberFormat("en-US", options);
    return formatter.format(n);
  };
};

/** 原币数量:千分位,最多 8 位小数(`1,234.5`、`0.00012345`)。 */
export const formatAmount = lazyFormat({ maximumFractionDigits: 8 });

/** 千分位,最多 2 位小数(不带符号 / 币种 —— 调用方自己拼)。 */
export const formatCents = lazyFormat({ maximumFractionDigits: 2 });

/** 千分位,整数。 */
export const formatWhole = lazyFormat({ maximumFractionDigits: 0 });

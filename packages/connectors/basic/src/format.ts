// provider-facing 展示格式化(detail markdown 用)。纯函数、无 env、不碰 SECRETS_KEY(原则 #5)。
// detail 是全站唯一不跟随显示币种/语言的部分(永久英文 + USD),故格式化在此固定,不走 app i18n。

// 数量:去尾零的十进制串(3 → "3"、0.0005 → "0.0005")。避免指数记法(token 数量常规量级)。
export function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const s = n.toFixed(8);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

// USD:定点两位 + 千分位(6000 → "$6,000.00")。deterministic,不依赖 toLocaleString 的运行时 locale。
export function formatUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${grouped}.${dec}`;
}

// connector 展示名的**兜底**(#467):目录还没到位时先显什么。
//
// 权威名住 connector manifest(`manifest.label`),经 server fn 的目录下发。它是部署内静态的、
// 缓存一次就不再变,所以「拿不到」只发生在**每次冷加载的第一帧** —— 而那一帧原来直接把内部 id
// 印在界面上(`hyperliquid` / `okx`),十行一起闪一下,像数据坏了。
//
// 现在那一帧至少是个像名字的名字。**根治在预取**(渲染徽标的路由把目录一起预取,见 routes 里的
// loader),这里只是最后一道 —— 新页面忘了预取、或者目录那条请求挂了,也不该露出内部 id。
//
// **两个不是「首字母大写」的**:`evm` → EVM、`okx` → OKX。列在这里是有意的重复,判据是
// 「这一帧只由这一处决定,而正确答案两秒后就会覆盖它」—— 所以宁可这一帧也是对的。
// manifest 仍是唯一权威:改名只会让这张表在那一帧略旧,不会让界面长期显错。
const ACRONYMS: Record<string, string> = { evm: "EVM", okx: "OKX" };

export function connectorLabelFallback(connectorId: string): string {
  if (!connectorId) return connectorId;
  return ACRONYMS[connectorId] ?? connectorId.charAt(0).toUpperCase() + connectorId.slice(1);
}

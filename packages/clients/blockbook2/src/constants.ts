// Trezor Blockbook v2 常量(不硬编码散落,见原则 #8)。

export const UPSTREAM = "blockbook";

// **多端点**:某个节点限流/故障就换下一个(见 client.ts 的轮询)。无需 env 配置。
export const BLOCKBOOK_BASES = [
  "https://btc2.trezor.io/api/v2",
  "https://btc3.trezor.io/api/v2",
  "https://btc4.trezor.io/api/v2",
  "https://btc5.trezor.io/api/v2",
];

// **刻意中性:不带项目名、不带仓库地址。**
// 这些请求打的是第三方(Trezor 的公共节点),而请求内容本身就是敏感的 —— 它带着 **xpub**
// (整个钱包的观察密钥)。UA 里写上「这是某某项目、作者在这个 GitHub」等于把「谁在看这个地址」
// 和一个具体的人绑在一起,而且让所有自托管实例可被归成一类。
//
// **不能直接不发**:Workers 的 fetch 默认不带 UA,而这类站点的 WAF 对无 UA 请求返 403 ——
// 这是仓库里记着的坑。所以给一个最常见、什么都不说的值:它是「未指明客户端」的事实标准,
// 过 WAF 没问题,而且因为太常见反而不构成指纹。
export const USER_AGENT = "Mozilla/5.0";

// xpub 端点的默认查询:服务端派生 + 汇总,只要已用地址。
export const DEFAULT_XPUB_DETAILS = "tokenBalances";
export const DEFAULT_XPUB_TOKENS = "used";

// —— 为什么这里**没有**速率闸 ——
// 判据是「有没有多个调用挤同一份额度」。这里是**四个公共节点轮流打**,而限流的应对是
// **换下一个节点**,不是排队等 —— 换一个立刻就能走,排队是白等。这两种策略叠加只会
// 让延迟乘起来(每个节点先自己退避几次再换下一个)。

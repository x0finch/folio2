// Bitcoin provider 常量(不硬编码散落进逻辑,见原则 #8)。
// Esplora 基址/UA/HTTP 归 @folio/mempool-client;派生/脚本类型/路径归 @folio/bitcoin-derive。此处只留 provider 自身口径。

// 可选自托管 Esplora 节点覆写(globalKeys 键名);值传给 mempool-client 的 baseUrl,空/缺 → 公共默认。
export const ESPLORA_BASE_ENV = "BITCOIN_ESPLORA_BASE";

export const SATS_PER_BTC = 100_000_000;

// xpub 派生扫描:每链(外部/找零)连续 GAP_LIMIT 个未用地址即停(BIP44 gap limit);
// 两链合计地址硬上限 ADDRESS_CAP,超限提前停并标记 truncated(CF Workers 子请求上限兜底)。
export const GAP_LIMIT = 20;
export const ADDRESS_CAP = 60;

// mainnet 地址前缀正则(前缀/字符集/长度粗校验;checksum 交 @scure 编码环节):
//   P2PKH 1… / P2SH 3…(base58,排除 0OIl)、bech32/bech32m bc1…(segwit v0/v1,小写)。
export const BTC_ADDRESS_RE = /^(bc1[a-z0-9]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,39})$/;
// 扩展公钥前缀(分流 xpub 模式 vs 单地址)。
export const EXT_PUBKEY_RE = /^(xpub|ypub|zpub)/;
// 扩展公钥完整校验(前缀 + base58 字符集 + 长度 ~111);排除 EVM 0x 与乱串。
export const EXT_PUBKEY_FULL_RE = /^(xpub|ypub|zpub)[1-9A-HJ-NP-Za-km-z]{100,115}$/;

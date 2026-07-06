// Bitcoin provider 常量(不硬编码散落进逻辑,见原则 #8)。
// 取数(含服务端派生)归 @folio/blockbook-client;脚本类型/token 造型/本地派生归 @folio/bitcoin-derive。此处只留 provider 自身口径。

export const SATS_PER_BTC = 100_000_000;

// mainnet 地址前缀正则(前缀/字符集/长度粗校验;checksum 交编码环节):
//   P2PKH 1… / P2SH 3…(base58,排除 0OIl)、bech32/bech32m bc1…(segwit v0/v1,小写)。
export const BTC_ADDRESS_RE = /^(bc1[a-z0-9]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,39})$/;
// 扩展公钥前缀(分流 xpub 模式 vs 单地址)。
export const EXT_PUBKEY_RE = /^(xpub|ypub|zpub)/;
// 扩展公钥完整校验(前缀 + base58 字符集 + 长度 ~111);排除 EVM 0x 与乱串。
export const EXT_PUBKEY_FULL_RE = /^(xpub|ypub|zpub)[1-9A-HJ-NP-Za-km-z]{100,115}$/;

// Bitcoin provider 常量(不硬编码散落进逻辑,见原则 #8)。

// 数据源:Esplora API(mempool.space 公共实例),免密钥。base 不含尾斜杠,path 以 / 开头。
export const ESPLORA_BASE_DEFAULT = "https://mempool.space/api";
// 可选自托管 Esplora 节点覆写(globalKeys 键名);不设/空则用公共默认。大钱包 / 隐私 / 无公共限额用。
export const ESPLORA_BASE_ENV = "BITCOIN_ESPLORA_BASE";
// CF Workers 出站需显式 UA(见 CLAUDE.md fetch 坑:缺 UA 可能静默 403)。
export const USER_AGENT = "folio (+https://github.com/x0finch/folio2)";

export const SATS_PER_BTC = 100_000_000;

// 地址详情端点:一次返回 chain_stats(已确认)+ mempool_stats(未确认)+ funded_txo_count(used 判定)。
export const ADDRESS_PATH = (addr: string) => `/address/${addr}`;

// xpub 派生扫描:每链(外部/找零)连续 GAP_LIMIT 个未用地址即停(BIP44 gap limit);
// 两链合计地址硬上限 ADDRESS_CAP,超限提前停并标记 truncated(CF Workers 子请求上限兜底)。
export const GAP_LIMIT = 20;
export const ADDRESS_CAP = 60;

// SLIP-132:任意扩展公钥统一换成 xpub 版本字节供 @scure/bip32 解析(见 derive.ts toXpub)。
export const XPUB_VERSION_HEX = "0488b21e";

// mainnet 地址前缀正则(前缀/字符集/长度粗校验;checksum 交 @scure 编码环节):
//   P2PKH 1… / P2SH 3…(base58,排除 0OIl)、bech32/bech32m bc1…(segwit v0/v1,小写)。
export const BTC_ADDRESS_RE = /^(bc1[a-z0-9]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,39})$/;
// 扩展公钥前缀(分流 xpub 模式 vs 单地址)。
export const EXT_PUBKEY_RE = /^(xpub|ypub|zpub)/;
// 扩展公钥完整校验(前缀 + base58 字符集 + 长度 ~111);排除 EVM 0x 与乱串。
export const EXT_PUBKEY_FULL_RE = /^(xpub|ypub|zpub)[1-9A-HJ-NP-Za-km-z]{100,115}$/;

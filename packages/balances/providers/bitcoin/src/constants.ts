// Bitcoin provider 常量(不硬编码散落进逻辑,见原则 #8)。

// 数据源:Esplora API(mempool.space 公共实例),免密钥。base 不含尾斜杠,path 以 / 开头。
// 阶段 2 再加 BITCOIN_ESPLORA_BASE env 覆写(自托管节点);阶段 1 只用公共默认。
export const ESPLORA_BASE_DEFAULT = "https://mempool.space/api";
// CF Workers 出站需显式 UA(见 CLAUDE.md fetch 坑:缺 UA 可能静默 403)。
export const USER_AGENT = "folio (+https://github.com/x0finch/folio2)";

export const SATS_PER_BTC = 100_000_000;

// 地址详情端点:一次返回 chain_stats(已确认)+ mempool_stats(未确认)。
export const ADDRESS_PATH = (addr: string) => `/address/${addr}`;

// mainnet 地址前缀正则(阶段 1 只做前缀/字符集/长度粗校验;阶段 2 引 @scure 后可收紧 checksum):
//   P2PKH 1… / P2SH 3…(base58,排除 0OIl)、bech32/bech32m bc1…(segwit v0/v1,小写)。
// 排除 EVM 0x…(非 1/3 开头)与扩展公钥 xpub/ypub/zpub(见 EXT_PUBKEY_RE)。
export const BTC_ADDRESS_RE = /^(bc1[a-z0-9]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,39})$/;
// 扩展公钥前缀(阶段 1 不支持派生 → 识别后拒绝;阶段 2 叠加)。
export const EXT_PUBKEY_RE = /^(xpub|ypub|zpub)/;

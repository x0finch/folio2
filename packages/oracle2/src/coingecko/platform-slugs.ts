// 非 EVM 链的显式 slug 对照:**我们的命名者 → CoinGecko 的 asset_platform id**。
//
// 为什么 EVM 不需要这张表:两边都能归到 `evm:<chainId>` —— CoinGecko 的 `chain_identifier`
// 就是那个数字,靠数字对齐不会歧义。非 EVM 没有这样的公共编号,是「连接器说 `solana`」
// 对「CoinGecko 说什么」,slug 对 slug。
//
// 三条链恰好两边同名 **纯属运气**,不是规律 —— 所以写下来。对不上的后果是这条链上的币
// 从此没价没图,而且不报错;`toCgkRefRows` 会把对不上的链单独喊出来(见 unmatchedPlatforms)。
export const NON_EVM_PLATFORMS: Readonly<Record<string, string>> = {
  solana: "solana",
  sui: "sui",
  cosmos: "cosmos",
};

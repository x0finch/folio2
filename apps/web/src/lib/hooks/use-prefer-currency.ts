// 多币种接缝(stub)。当前偏好币种恒 USD;正式做多币种时在此接入汇率源 + 用户偏好 + 缓存,
// useDisplayValue 及所有调用点无需改动。
//   rate = 1 单位目标币种的美元价(USD 自身为 1);展示值 = usdValue / rate。
//   unit = 展示用货币符号前缀(如 "$"),多币种时随偏好币种变。
//   isLoading 预留给汇率加载态(现恒 false)。
export interface PreferCurrency {
  currency: string; // ISO 4217
  unit: string; // 货币符号前缀
  rate: number;
  isLoading: boolean;
}

export function usePreferCurrency(): PreferCurrency {
  return { currency: "USD", unit: "$", rate: 1, isLoading: false };
}

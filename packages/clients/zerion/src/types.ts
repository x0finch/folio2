// Zerion 响应的**最小形状**(仅取用到的字段)。原样搬自老 provider 包。

export interface ZerionQuantity {
  float?: number;
}

export interface ZerionImplementation {
  chain_id?: string;
  address?: string | null; // 原生币为 null
}

export interface ZerionPosition {
  attributes?: {
    protocol?: string | null;
    position_type?: string;
    quantity?: ZerionQuantity;
    value?: number | null;
    price?: number | null;
    fungible_info?: {
      symbol?: string;
      name?: string;
      icon?: { url?: string } | null;
      implementations?: ZerionImplementation[];
    };
    flags?: { displayable?: boolean };
  };
  relationships?: { chain?: { data?: { id?: string } } };
}

export interface ZerionPositionsResponse {
  data?: ZerionPosition[];
}

export interface ZerionChain {
  id?: string; // slug(与 positions 的 relationships.chain 同口径)
  attributes?: { external_id?: string }; // hex 数字 chainId(如 "0x1")—— 只在此端点给
}

export interface ZerionChainsResponse {
  data?: ZerionChain[];
}

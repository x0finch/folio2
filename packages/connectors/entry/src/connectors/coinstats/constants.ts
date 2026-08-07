// coinstats **适配层**的常量(原则 #8)。端点路径 / base / 限频参数 / key 头全归
// `@folio/coinstats-client` —— 那一半是「怎么跟上游说话」(ADR 0036)。

// provider 的 id,同时是 `tokenRef.issued(...)` 的发行方标识。
export const PROVIDER_ID = "coinstats";

// provider 级 key 的 **env 变量名**(不是 key 的值)。app 据它从 env 读值灌进 ctx.creds;
// 同时也是那把 key 的限频队标识(三条链共享同一份额度,队在 client 里)。
export const COINSTATS_API_KEY = "COINSTATS_API_KEY";

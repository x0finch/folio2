// 读接口的「原样 JSON」传输(FOL-92)。
//
// server fn 的默认出口是 seroval:它能序列化 Map / Date / Promise / 循环引用,代价是**逐个节点**
// 走一遍 —— 几百行的曲线原料、几十行的持仓,每个键每个值都是 Worker 的 CPU(免费档一请求 10ms)。
// 这几条读接口的返回值本来就是纯 JSON(数字、字符串、null、数组、平铺对象),用不着那套本事,
// 于是服务端直接交一个 `Response`(`JSON.stringify` 是引擎原生的),TanStack Start 对 `Response`
// 原样放行(打上 `x-tss-raw`),浏览器这边 `readJson` 解回来。
//
// **只给返回纯 JSON 的接口用**:`undefined` 字段会消失、`NaN` 会变 `null`、Map / Date 会坏。
// 错误那条路不变 —— handler 失败时这里根本不会造 Response,照旧由 Start 序列化成错误。

declare const JSON_BODY: unique symbol;

/** 带着 body 类型的 `Response` —— 只在类型层记住「解出来是什么」,运行时就是一个普通 Response。 */
export type JsonResponse<T> = Response & { readonly [JSON_BODY]?: T };

/** 浏览器侧:把 `JsonResponse<T>` 解回 `T`。 */
export const readJson = <T>(res: JsonResponse<T>): Promise<T> => res.json() as Promise<T>;

/** `JsonResponse<T>` 里记着的那个 `T`(给「这个接口返回什么形状」那类类型别名用)。 */
export type JsonBody<R> = R extends JsonResponse<infer T> ? T : never;

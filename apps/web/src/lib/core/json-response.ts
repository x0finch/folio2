// Raw-JSON transport for read endpoints: seroval walks every node, which costs Worker CPU
// (10ms/request on the free tier); returning a `Response` lets Start pass it through untouched.
// Only for plain-JSON payloads: `undefined` fields vanish, `NaN` becomes null, Map/Date break.

declare const JSON_BODY: unique symbol;

/** Type-level only: remembers the body type; at runtime a plain Response. */
export type JsonResponse<T> = Response & { readonly [JSON_BODY]?: T };

export const readJson = <T>(res: JsonResponse<T>): Promise<T> => res.json() as Promise<T>;

export type JsonBody<R> = R extends JsonResponse<infer T> ? T : never;

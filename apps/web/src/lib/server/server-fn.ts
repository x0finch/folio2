import { Effect } from "effect";

/**
 * `Effect.fn(name)` for server-fn handlers. `runEffect` labels its timing log with the handler's
 * function name, and the function `Effect.fn` returns is anonymous, so the name is set here.
 */
export const serverFn = (name: string): Effect.fn.Traced => {
  const make = Effect.fn(name) as (...args: Array<unknown>) => object;
  return ((...args: Array<unknown>) =>
    Object.defineProperty(make(...args), "name", { value: name })) as Effect.fn.Traced;
};

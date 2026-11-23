import { vi } from "vitest";

// Outbound fetch is blocked by default so "this path must not hit the network" is assertable and
// nothing silently calls a real upstream.

export interface Outbound {
  readonly calls: string[];
}

export const blockOutbound = (): Outbound => {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    throw new Error(`Unexpected outbound request in this test: ${url}`);
  });
  return { calls };
};

/** Matches on URL fragments, not full URLs: upstream URLs carry keys, timestamps and sort params. */
export const stubOutbound = (
  routes: ReadonlyArray<readonly [match: string, respond: () => Response]>,
): Outbound => {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    for (const [match, respond] of routes) {
      if (url.includes(match)) return respond();
    }
    throw new Error(`No canned response for URL: ${url}`);
  });
  return { calls };
};

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

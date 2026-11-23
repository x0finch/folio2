import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A single AudioContext is shared page-wide, created lazily and closed by the last disposer.

class FakeSource {
  buffer: unknown = null;
  playbackRate = { value: 1 };
  onended: (() => void) | null = null;
  stopped = false;
  connect() {}
  disconnect() {}
  start() {}
  stop() {
    this.stopped = true;
  }
}

const instances: FakeContext[] = [];

class FakeContext {
  sampleRate = 48_000;
  state: "running" | "suspended" | "closed" = "running";
  destination = { kind: "destination" };
  closed = 0;
  resumed = 0;
  sources: FakeSource[] = [];
  constructor() {
    instances.push(this);
  }
  createGain() {
    return { gain: { value: 1 }, context: this, connect() {} };
  }
  createBuffer(_channels: number, length: number) {
    const data = new Float32Array(length);
    return { length, getChannelData: () => data };
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  resume() {
    this.resumed++;
    return Promise.resolve();
  }
  close() {
    this.closed++;
    this.state = "closed";
    return Promise.resolve();
  }
}

// Module-level state (ctx / refcount) must start fresh per case, so re-import each time.
async function load() {
  vi.resetModules();
  return import("../src/lib/tick-sound");
}

beforeEach(() => {
  instances.length = 0;
  vi.stubGlobal("window", { AudioContext: FakeContext });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createTickPlayer", () => {
  it("creating a player does not open an AudioContext until the first prepare", async () => {
    const { createTickPlayer } = await load();
    const p = createTickPlayer();
    expect(instances).toHaveLength(0);
    p.prepare();
    expect(instances).toHaveLength(1);
  });

  it("multiple players share one context", async () => {
    const { createTickPlayer } = await load();
    const a = createTickPlayer();
    const b = createTickPlayer();
    a.play();
    b.play();
    expect(instances).toHaveLength(1);
    expect(instances[0].sources).toHaveLength(2);
  });

  it("tries to resume a suspended context", async () => {
    const { createTickPlayer } = await load();
    const p = createTickPlayer();
    p.prepare();
    expect(instances[0].resumed).toBe(0);
    instances[0].state = "suspended";
    p.prepare();
    expect(instances[0].resumed).toBe(1);
  });

  it("does not throw when the browser rejects resume (non-gesture)", async () => {
    const { createTickPlayer } = await load();
    const p = createTickPlayer();
    p.prepare();
    instances[0].state = "suspended";
    instances[0].resume = () => Promise.reject(new Error("not allowed"));
    expect(() => p.play()).not.toThrow();
    await Promise.resolve();
  });

  it("closes the context only on the last dispose", async () => {
    const { createTickPlayer } = await load();
    const a = createTickPlayer();
    const b = createTickPlayer();
    a.play();
    a.dispose();
    expect(instances[0].closed).toBe(0);
    b.play();
    expect(instances[0].sources).toHaveLength(2);
    b.dispose();
    expect(instances[0].closed).toBe(1);
  });

  it("dispose stops the playing tick; later play/prepare do nothing", async () => {
    const { createTickPlayer } = await load();
    const keep = createTickPlayer();
    const p = createTickPlayer();
    p.play();
    const [src] = instances[0].sources;
    p.dispose();
    expect(src.stopped).toBe(true);
    p.play();
    p.prepare();
    expect(instances[0].sources).toHaveLength(1);
    keep.dispose();
  });

  it("repeated dispose does not over-decrement the refcount", async () => {
    const { createTickPlayer } = await load();
    const a = createTickPlayer();
    const b = createTickPlayer();
    a.prepare();
    a.dispose();
    a.dispose();
    expect(instances[0].closed).toBe(0);
    b.dispose();
    expect(instances[0].closed).toBe(1);
  });

  it("a new user after close opens a fresh context", async () => {
    const { createTickPlayer } = await load();
    const a = createTickPlayer();
    a.play();
    a.dispose();
    createTickPlayer().play();
    expect(instances).toHaveLength(2);
    expect(instances[1].sources).toHaveLength(1);
  });

  it("is silent without Web Audio / window (SSR)", async () => {
    vi.stubGlobal("window", {});
    let mod = await load();
    expect(() => mod.createTickPlayer().play()).not.toThrow();
    vi.stubGlobal("window", undefined);
    mod = await load();
    const p = mod.createTickPlayer();
    expect(() => {
      p.prepare();
      p.play();
      p.dispose();
    }).not.toThrow();
    expect(instances).toHaveLength(0);
  });
});

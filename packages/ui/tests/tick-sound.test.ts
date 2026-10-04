import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 滚轮选择器的「咔嗒」声:整页共用一个 AudioContext(多个滚轮并排也只开一个)、懒创建、
// 最后一个使用者 dispose 才关;快速滑动时切掉上一声的尾巴;没有 Web Audio(SSR / 老浏览器)时静默。
// node 环境里没有 Web Audio,这里只替换这一层浏览器 API。

class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  disconnected = false;
  connectedTo: unknown = null;
  connect(node: unknown) {
    this.connectedTo = node;
  }
  disconnect() {
    this.disconnected = true;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}

class FakeBuffer {
  readonly data: Float32Array;
  constructor(
    readonly channels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = new Float32Array(length);
  }
  getChannelData() {
    return this.data;
  }
}

const instances: FakeContext[] = [];

class FakeContext {
  sampleRate = 48_000;
  state: "running" | "suspended" | "closed" = "running";
  destination = { kind: "destination" };
  closed = 0;
  resumed = 0;
  gains: { gain: { value: number }; connectedTo: unknown }[] = [];
  buffers: FakeBuffer[] = [];
  sources: FakeSource[] = [];
  constructor() {
    instances.push(this);
  }
  createGain() {
    const node = {
      gain: { value: 1 },
      connectedTo: null as unknown,
      connect(n: unknown) {
        node.connectedTo = n;
      },
    };
    this.gains.push(node);
    return node;
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    const b = new FakeBuffer(channels, length, sampleRate);
    this.buffers.push(b);
    return b;
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

// 模块级共享状态(ctx / 引用计数)每个用例都要从零开始 → 每次重新导入。
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
  it("创建 player 不开 AudioContext,第一次 prepare 才开", async () => {
    const { createTickPlayer } = await load();
    const p = createTickPlayer();
    expect(instances).toHaveLength(0);
    p.prepare();
    expect(instances).toHaveLength(1);
  });

  it("多个 player 共用同一个 context", async () => {
    const { createTickPlayer } = await load();
    const a = createTickPlayer();
    const b = createTickPlayer();
    a.play();
    b.play();
    expect(instances).toHaveLength(1);
    expect(instances[0].sources).toHaveLength(2);
  });

  it("play 出一声:源接到主音量(主音量很小并接到输出),并真的 start", async () => {
    const { createTickPlayer } = await load();
    createTickPlayer().play();
    const ctx = instances[0];
    const [gain] = ctx.gains;
    const [src] = ctx.sources;
    expect(src.started).toBe(true);
    expect(src.connectedTo).toBe(gain);
    expect(src.buffer).toBe(ctx.buffers[0]);
    expect(gain.connectedTo).toBe(ctx.destination);
    expect(gain.gain.value).toBeGreaterThan(0);
    expect(gain.gain.value).toBeLessThan(0.1);
  });

  it("咔嗒声很短(16ms)且归一化到峰值 0.9", async () => {
    const { createTickPlayer } = await load();
    createTickPlayer().prepare();
    const [buf] = instances[0].buffers;
    expect(buf.length).toBe(Math.ceil(0.016 * 48_000));
    const peak = Math.max(...Array.from(buf.data, Math.abs));
    expect(peak).toBeCloseTo(0.9, 6);
  });

  it("快速连响:新的一声切掉上一声的尾巴", async () => {
    const { createTickPlayer } = await load();
    const p = createTickPlayer();
    p.play();
    p.play();
    const [first, second] = instances[0].sources;
    expect(first.stopped).toBe(true);
    expect(second.stopped).toBe(false);
  });

  it("一声自然放完后断开,下一声不再去 stop 它", async () => {
    const { createTickPlayer } = await load();
    const p = createTickPlayer();
    p.play();
    const [first] = instances[0].sources;
    first.onended?.();
    expect(first.disconnected).toBe(true);
    p.play();
    expect(first.stopped).toBe(false);
  });

  it("context 被挂起时尝试 resume", async () => {
    const { createTickPlayer } = await load();
    const p = createTickPlayer();
    p.prepare();
    expect(instances[0].resumed).toBe(0);
    instances[0].state = "suspended";
    p.prepare();
    expect(instances[0].resumed).toBe(1);
  });

  it("resume 被浏览器拒绝(非手势触发)不抛", async () => {
    const { createTickPlayer } = await load();
    const p = createTickPlayer();
    p.prepare();
    instances[0].state = "suspended";
    instances[0].resume = () => Promise.reject(new Error("not allowed"));
    expect(() => p.play()).not.toThrow();
    await Promise.resolve();
  });

  it("最后一个使用者 dispose 才关 context;之前的 dispose 不影响别人", async () => {
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

  it("dispose 停掉正在响的那声,之后的 play/prepare 什么都不做", async () => {
    const { createTickPlayer } = await load();
    const keep = createTickPlayer(); // 另一个使用者还在,context 不关
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

  it("重复 dispose 不会多扣引用计数(别人的 context 不被提前关掉)", async () => {
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

  it("关掉之后再有新使用者,会重新开一个 context", async () => {
    const { createTickPlayer } = await load();
    const a = createTickPlayer();
    a.play();
    a.dispose();
    createTickPlayer().play();
    expect(instances).toHaveLength(2);
    expect(instances[1].sources).toHaveLength(1);
  });

  it("只有 webkitAudioContext 的浏览器也能响", async () => {
    vi.stubGlobal("window", { webkitAudioContext: FakeContext });
    const { createTickPlayer } = await load();
    createTickPlayer().play();
    expect(instances[0].sources[0].started).toBe(true);
  });

  it("没有 Web Audio / 没有 window(SSR)时静默,不抛", async () => {
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

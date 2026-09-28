import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JOB_MAX_RETRIES } from "@/lib/server/jobs/constants";

// 队列的配置约束(FOL-86)。它们是**配置**,没有别的地方会验:
//   · 每个 env 的 consumer 都得是「一次调用一条」—— 批大于 1,一次调用的 10ms CPU / 50 subrequest
//     预算就又得被几个账户分着花,FOL-86 白做;
//   · `max_retries` 必须与代码里的 `JOB_MAX_RETRIES` 一致 —— consumer 靠它认「最后一次投递」,
//     对不上的话要么提前放弃(少重试)、要么永远等不到收尾那一次(账户在轮里一直 pending);
//   · 每个 env 都要有自己的一份(env 不继承顶层,少一份那个环境就没有 JOBS 绑定)。

const WRANGLER = join(import.meta.dirname, "../wrangler.jsonc");

// 去掉 `//` 行注释再当 JSON 读。只处理这份文件用到的形态:注释独占一行或跟在值后面,
// 字符串里没有 `//`(URL 在注释里,不在值里)。
const readConfig = () => {
  const text = readFileSync(WRANGLER, "utf8")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"])\/\/.*$/, "$1"))
    .join("\n")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(text) as {
    queues?: Queues;
    triggers?: unknown;
    env: Record<string, { queues?: Queues; triggers?: unknown }>;
  };
};

interface Queues {
  producers: { binding: string; queue: string }[];
  consumers: {
    queue: string;
    max_batch_size?: number;
    max_retries?: number;
    dead_letter_queue?: string;
  }[];
}

const all = () => {
  const cfg = readConfig();
  return [
    ["top-level", cfg.queues],
    ...Object.entries(cfg.env).map(([name, e]) => [name, e.queues] as const),
  ] as const;
};

describe("队列配置", () => {
  it.each(all())("%s:有 JOBS 生产者,且消费的正是它投的那条队列", (_name, queues) => {
    const producer = queues?.producers.find((p) => p.binding === "JOBS");
    expect(producer).toBeDefined();
    expect(queues?.consumers.map((c) => c.queue)).toEqual([producer?.queue]);
  });

  it.each(all())("%s:一次调用一条,重试次数与 JOB_MAX_RETRIES 一致,有死信队列", (_n, queues) => {
    for (const c of queues?.consumers ?? []) {
      expect(c.max_batch_size).toBe(1);
      expect(c.max_retries).toBe(JOB_MAX_RETRIES);
      expect(c.dead_letter_queue).toBeTruthy();
      expect(c.dead_letter_queue).not.toBe(c.queue);
    }
  });

  it("各 env 的队列名互不相同 —— preview 投的活不会被生产消费", () => {
    const names = all().map(([, q]) => q?.producers[0]?.queue);
    expect(new Set(names).size).toBe(names.length);
  });

  it("preview 没有 cron —— 队列在那里只接手动投的活", () => {
    expect(readConfig().env.preview?.triggers).toBeUndefined();
  });
});

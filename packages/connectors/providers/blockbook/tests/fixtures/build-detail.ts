// buildBtcDetail 的 golden fixture(input → 期望 markdown)。
// 用 .ts + 模板字符串:expected 直接多行可读(免 JSON 的 \n 转义);地址用常量插值,input/URL 单一源不漂移。
// 分布结构:*Receive* / *Change* 两子列表(仅该子列表有地址才出子标题)。

export type BuildDetailCase = {
  note: string;
  input: {
    pendingSats: number;
    dist: { address: string; chain: "receive" | "change"; balanceSats: number }[];
    receive?: {
      lastUsed: { index: number; address: string } | null;
      next: { index: number; address: string }[];
    };
  };
  expected: string;
};

const RECV0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const RECV1 = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";
const RECV2 = "bc1qp59yckz4ae5c4efgw2s5wfyvrz0ala7rgvuz8z";
const CHANGE0 = "bc1qchange0";
const URL = "https://mempool.space/address/";

export const buildDetailFixtures: Record<"full" | "addressOnly" | "receiveOnly", BuildDetailCase> =
  {
    full: {
      note: "未确认 + 收款指引 + 分布(receive/change 两子列表)",
      input: {
        pendingSats: 500000,
        dist: [
          { address: RECV0, chain: "receive", balanceSats: 50000 },
          { address: CHANGE0, chain: "change", balanceSats: 30000 },
        ],
        receive: {
          lastUsed: { index: 0, address: RECV0 },
          next: [
            { index: 1, address: RECV1 },
            { index: 2, address: RECV2 },
          ],
        },
      },
      expected: `**Unconfirmed:** +0.005 BTC

**Receive addresses**
- Last used (#0): [bc1qcr8te4…306fyu](${URL}${RECV0})
- Next #1: [bc1qnjg0jd…erkf9g](${URL}${RECV1})
- Next #2: [bc1qp59yck…gvuz8z](${URL}${RECV2})

**Distribution**

*Receive*
- [bc1qcr8te4…306fyu](${URL}${RECV0}) — 0.0005 BTC

*Change*
- [bc1qchange0](${URL}${CHANGE0}) — 0.0003 BTC`,
    },

    addressOnly: {
      note: "仅地址模式:只有未确认,无分布/收款指引",
      input: { pendingSats: 500000, dist: [] },
      expected: `**Unconfirmed:** +0.005 BTC`,
    },

    receiveOnly: {
      note: "分布全在 receive 链 → 只出 *Receive* 子列表,无 *Change*",
      input: {
        pendingSats: 0,
        dist: [{ address: RECV0, chain: "receive", balanceSats: 50000 }],
      },
      expected: `**Distribution**

*Receive*
- [bc1qcr8te4…306fyu](${URL}${RECV0}) — 0.0005 BTC`,
    },
  };

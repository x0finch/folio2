// manual 多 token 抽屉 UI 的共享输入类型(从原型内存 store 抽出;store 退役后由此承载)。
// 纯类型,无逻辑 —— 抽屉面板与活动 modal 共用的「选币结果」「活动草稿」形状。持久化事实源在服务端
// (manual-batch / server fn);这里只描述 UI → server fn 的入参形状。

// 用户在抽屉里**选中的币**(选币结果 + 市价单价)。活动可指向尚未持有的 token → 提交时按需现建。
//
// `ticket` 就是选币下拉给的那串(见 lib/token-option.ts):**原样搬运,不解释**。
// 没有它 = 用户没在下拉里选、自己敲了个 symbol(那种币服务端按 symbol 认,认不出来就自己一行)。
export interface PickedToken {
  symbol: string;
  ticket?: string;
  logo?: string;
  name?: string;
  unitPrice: number;
}

// 活动 modal 暂存的一条草稿(token 维度)。createdAt 由 modal 按提交序赋(仅前端排序用;
// 入库定序由服务端 planManualBatch/commit 重定,见 T3)。
export interface ActivityDraft {
  token: PickedToken;
  kind: "add" | "reduce" | "set";
  amount: number;
  occurredAt: number;
  createdAt: number;
  memo?: string;
  price?: number;
  fee?: number;
}

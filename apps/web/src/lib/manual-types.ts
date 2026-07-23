// manual 多 token 抽屉 UI 的共享输入类型(从原型内存 store 抽出;store 退役后由此承载)。
// 纯类型,无逻辑 —— 抽屉面板与活动 modal 共用的「选币结果」「活动草稿」形状。持久化事实源在服务端
// (manual-batch / server fn);这里只描述 UI → server fn 的入参形状。

// 活动流引用的 token(CGK 选币结果 + 市价单价)。活动可指向尚未持有的 token → 提交时按需现建。
export interface DraftTokenRef {
  symbol: string;
  identifier?: string;
  logo?: string;
  name?: string;
  unitPrice: number;
}

// 活动 modal 暂存的一条草稿(token 维度)。createdAt 由 modal 按提交序赋(仅前端排序用;
// 入库定序由服务端 planManualBatch/commit 重定,见 T3)。
export interface ActivityDraft {
  token: DraftTokenRef;
  kind: "add" | "reduce" | "set";
  amount: number;
  occurredAt: number;
  createdAt: number;
  memo?: string;
  price?: number;
  fee?: number;
}

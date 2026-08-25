import { z } from "zod";

// 手记活动的「什么时候发生的」。**不能是未来**(#527 裁定 6):净值曲线按活动累积,一条未来的
// 买入会让曲线右端翘起一块还没发生的资产,而那一块看起来和真的一样。
//
// 留一点缓冲而不是严格 `<= now`:时间戳由浏览器给,客户端时钟快几秒是常事,严格挡会把
// 「刚刚记的一笔」误拒 —— 那种拒绝没有任何可操作的解释可给用户。
const FUTURE_SKEW_MS = 5 * 60 * 1000;

// **只挡 handler 这一层,不挡导入。** 导入恢复的是既有备份,里面的时间戳是这条规则之前写的;
// 在那条路上拒等于让一份能导出的备份导不回来。
export const OccurredAt = z
  .number()
  .int()
  .refine((ms) => ms <= Date.now() + FUTURE_SKEW_MS, {
    message: "occurredAt must not be in the future",
  });

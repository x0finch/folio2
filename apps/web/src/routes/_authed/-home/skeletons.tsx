import { Skeleton } from "@folio/ui";
import { GainSkeleton } from "../../../components/skeletons";

// 首页各岛的骨架:形状贴合真实布局,避免加载时空白跳动。
// 稳定 key(避免 index key lint):占位行数固定,用字符串数组当 key。
const ROWS_5 = ["r1", "r2", "r3", "r4", "r5"];
const ROWS_3 = ["r1", "r2", "r3"];

function Row() {
  return (
    <div className="flex items-center gap-3 px-3 py-3">
      <Skeleton className="size-8 shrink-0 rounded-full" />
      <div className="flex flex-1 flex-col gap-1.5">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-16" />
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <Skeleton className="h-4 w-20" />
        <GainSkeleton />
      </div>
    </div>
  );
}

export function HeroSkeleton() {
  // 与 PortfolioHero 外框 `min-h-60` 同高,tab 条不会在数字到位时被顶下去。
  return <Skeleton className="min-h-60 w-full" />;
}

export function TabStripSkeleton() {
  return (
    <div className="flex items-center gap-4">
      <Skeleton className="h-8 w-64 rounded-full" />
      <TabTotalSkeleton />
    </div>
  );
}

/** tab 条右侧合计位。宽度与真条 `min-w-24` 同锁:切 pin 时不能缩,否则条子变宽、裁掉的 tab 闪一下。 */
export function TabTotalSkeleton() {
  return <Skeleton className="inline-block h-4 w-24 rounded-full" />;
}

export function HoldingsSkeleton() {
  return (
    <div className="flex flex-col">
      {ROWS_5.map((k) => (
        <Row key={k} />
      ))}
    </div>
  );
}

// 短列表骨架(3 行,无 Card):自定义 Tab 首次拉取过滤后内容时占位 —— 避免退回展示未收窄的全量数据。
export function ListSkeleton() {
  return (
    <div className="flex flex-col">
      {ROWS_3.map((k) => (
        <Row key={k} />
      ))}
    </div>
  );
}

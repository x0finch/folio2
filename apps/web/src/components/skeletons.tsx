import { Card, CardContent, CardHeader, cn, Skeleton } from "@folio/ui";

// 路由 pendingComponent 用的骨架态:形状贴合各页真实布局,避免加载时空白跳动。
// 稳定 key(避免 index key lint):占位行数固定,用字符串数组当 key。
const ROWS_5 = ["r1", "r2", "r3", "r4", "r5"];
const ROWS_4 = ["r1", "r2", "r3", "r4"];
const ROWS_3 = ["r1", "r2", "r3"];
const CARDS_2 = ["c1", "c2"];

// 24h 盈亏那条读还没回来时,盈亏位画的东西(#488)。**四处共用这一个元件** —— 代币行、
// 代币抽屉头、hero 药丸、hero 的 best/worst 三指标。
//
// 为什么非得共用:这四处原先各手写一遍 `h-2.5 … animate-pulse`,而它们已经长歪了 ——
// 有的 `bg-muted`、有的 `bg-muted-foreground/20`。骨架的全部意义在于「与它替换掉的东西同形」,
// 四份各自演化的话,下一次调排版必然漏掉其中一处,而漏掉不报错,只是那一处填充时抖一下。
//
// 宽度由调用方给(各处真值长度不同,骨架要跟真值锁死,不是跟彼此锁死);tone 只有两档:
// 默认落在页面底色上,`onMuted` 落在 hero 那个 bg-muted 药丸里 —— 同色会看不见。
export function GainSkeleton({
  className,
  tone = "default",
}: {
  className?: string;
  tone?: "default" | "onMuted";
}) {
  return (
    <Skeleton
      className={cn("h-2.5 rounded", tone === "onMuted" && "bg-muted-foreground/20", className)}
    />
  );
}

function Row() {
  return (
    <div className="flex items-center gap-3">
      <Skeleton className="size-9 shrink-0 rounded-full" />
      <div className="flex flex-1 flex-col gap-1.5">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-16" />
      </div>
      <Skeleton className="h-4 w-20" />
    </div>
  );
}

// 首页两块各自的骨架。**分开导出是有用途的,不是拆着好看**:首页的 hero 与持仓列表是两个独立
// 挂起的区块(各自 QueryBoundary),谁先拿到数据谁先亮 —— 各自的 Suspense fallback 就是这两个。
// 首页**没有路由级骨架**:那条路由的 loader 只发请求、同步返回,永远不进 pending 态,所以曾经
// 那个把两块拼起来的 `OverviewSkeleton` 是死代码,已删。
// hero 骨架高度对着 PortfolioHero 的 min-h-60(h-56 + 外层 gap)—— 改那边的高度记得回来改这里。
export function HeroSkeleton() {
  return <Skeleton className="h-56 w-full rounded-xl" />;
}

// 持仓:pill tabs(左)+ 该视角合计(右)+ 行(无 Card)
export function HoldingsSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-9 w-64 rounded-full" />
        <Skeleton className="h-4 w-24" />
      </div>
      <div className="flex flex-col gap-4">
        {ROWS_5.map((k) => (
          <Row key={k} />
        ))}
      </div>
    </div>
  );
}

// 短列表骨架(3 行,无 Card):自定义 Tab 首次拉取过滤后内容时占位 —— 避免退回展示未收窄的全量数据。
export function ListSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      {ROWS_3.map((k) => (
        <Row key={k} />
      ))}
    </div>
  );
}

// 账户行骨架:贴合 v2 行(无前导头像)—— 左 名称/状态/代币叠标,右 市值/增量;无 Card,与真实列表同 padding。
function AccountRow() {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-3">
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <div className="flex flex-col items-end gap-1.5">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-3 w-14" />
      </div>
    </div>
  );
}

export function AccountsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-8 w-40" />
      <div className="flex flex-col">
        {ROWS_4.map((k) => (
          <AccountRow key={k} />
        ))}
      </div>
    </div>
  );
}

export function InsightsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      {CARDS_2.map((k) => (
        <Card key={k}>
          <CardHeader>
            <Skeleton className="h-5 w-24" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-52 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

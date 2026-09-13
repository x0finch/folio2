import { Card, CardContent, CardHeader, Skeleton } from "@folio/ui";
import { CHART_FRAME } from "./-insights/chart-frame";

// 四个 page 各自的首访骨架(FOL-81):切到一个没进过的页、它的 chunk 还在下载时,由这一张顶住内容区
// (外壳、导航、Dock 已在 AppShell 里渲好)。chunk 一到、组件挂载,页面自己 QueryBoundary 那套
// 岛级骨架接手数据态;去过的页由 <Activity> 保活,回访不再经这里。
//
// **每页一张、各是各的形状**,不共用:加载态也该是对的形状(FOL-69 故事 3)。这几张只能用 @folio/ui
// 的原语拼 —— 页面自己那套岛级骨架住在各页的 chunk 里,从这儿引就把 chunk 拖进首包了,严格 lazy 白做。

// 骨架里的占位槽:三个小指标 + 六行列表(六行刚好铺满手机首屏)。
const STAT_SLOTS = ["s1", "s2", "s3"];
const HOLDING_ROWS = ["r1", "r2", "r3", "r4", "r5", "r6"];
const ACCOUNT_ROWS = ["r1", "r2", "r3", "r4"];
const ALLOC_LEGEND = ["l1", "l2", "l3", "l4"];
// 设置页七张卡(用户 / 外观 / 自动锁 / Passkey / Provider key / 估值 / 数据)。
const SETTINGS_CARDS = ["c1", "c2", "c3", "c4", "c5", "c6", "c7"];

// 总览:这一张同时是 `AppShellSkeleton` 内容区的那一张(服务端唯一渲染的骨架壳,ADR 0049)——
// **同一个组件、两处渲染**,冷启动「骨架壳 → 外壳 + 本页骨架 → 真页」三段里前两段的内容区逐像素相同,
// 不会因为是两份代码而各自漂移。所以它必须保持零 hook、零 provider(见 tests/app-shell-skeleton)。
//
// 每个盒子按 390px 下的真总览量过:hero 240、tab 行 32、列表行 72。改这里 = 改冷启动首帧,别顺手。
export function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      {/* 净值块:标题 + 大数字 + 三个小指标,高度锁 min-h-60 与真块一致。 */}
      <div className="min-h-60 pt-1">
        <Skeleton className="h-4 w-28" />
        <div className="mt-2 flex h-13 items-start gap-3">
          <Skeleton className="h-10 w-56" />
          <Skeleton className="h-9 w-24 rounded-full" />
        </div>
        <div className="mt-6 flex flex-wrap gap-8">
          {STAT_SLOTS.map((k) => (
            <div key={k}>
              <Skeleton className="h-4 w-16" />
              <Skeleton className="mt-0.5 h-5 w-20" />
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {/* 分类标签行 + 右侧合计。 */}
        <div className="flex items-center gap-4">
          <Skeleton className="h-8 w-56 rounded-full" />
          <Skeleton className="ml-auto h-4 w-24" />
        </div>
        {/* 列表位:h-18 = 72,与真列表逐行对齐(高度含内边距,别写成内容高)。 */}
        <div className="flex w-full flex-col">
          {HOLDING_ROWS.map((k) => (
            <div key={k} className="flex h-18 items-center gap-3 px-3 py-3">
              <Skeleton className="size-10 shrink-0 rounded-full" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-20" />
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-16" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// 账户:「N 个账户」标题 + 名单行(名字 / 状态行 + 右侧余额 / 24h 增量)。形状对齐页内 `ListSkeleton`。
export function AccountsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-8 w-40" />
      <div className="flex flex-col">
        {ACCOUNT_ROWS.map((k) => (
          <div key={k} className="flex items-center justify-between gap-4 px-3 py-3">
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-20" />
              <span className="min-h-6" />
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-3 w-14" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// 洞察:走势卡(标题 + 图框)+ 分布卡(维度 tab 行 + 环形图 + 图例)。
export function InsightsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-20" />
        </CardHeader>
        <CardContent>
          <Skeleton className={CHART_FRAME} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-24" />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Skeleton className="h-8 w-56" />
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
            {/* 220 = 真环形图的画布边长(allocation-pie)。 */}
            <Skeleton className="mx-auto size-55 shrink-0 rounded-full" />
            <ul className="flex flex-1 flex-col gap-1.5">
              {ALLOC_LEGEND.map((k) => (
                <li key={k} className="flex items-center gap-2">
                  <Skeleton className="size-3 rounded-sm" />
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="ml-auto h-4 w-12" />
                </li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// 设置:一列卡片,各一条标题 + 两行设置项。
export function SettingsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      {SETTINGS_CARDS.map((k) => (
        <Card key={k}>
          <CardHeader>
            <Skeleton className="h-5 w-28" />
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

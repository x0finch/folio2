import { Card, CardContent, CardHeader, Skeleton } from "@folio/ui";
import { CHART_FRAME } from "@/routes/_authed/-insights/chart-frame";

// First-visit skeletons shown while a page's chunk downloads. Built only from @folio/ui primitives:
// importing a page's own skeletons would pull its chunk into the main bundle.

const STAT_SLOTS = ["s1", "s2", "s3"];
const HOLDING_ROWS = ["r1", "r2", "r3", "r4", "r5", "r6"];
const ACCOUNT_ROWS = ["r1", "r2", "r3", "r4"];
const ALLOC_LEGEND = ["l1", "l2", "l3", "l4"];
const SETTINGS_CARDS = ["c1", "c2", "c3", "c4", "c5", "c6", "c7"];

// Also rendered inside AppShellSkeleton, so it must stay hook- and provider-free. Box sizes match
// the real overview at 390px; changing them changes the cold-start first frame.
export function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-6">
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
        <div className="flex items-center gap-4">
          <Skeleton className="h-8 w-56 rounded-full" />
          <Skeleton className="ml-auto h-4 w-24" />
        </div>
        {/* h-18 = 72px including padding, matching real list rows. */}
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
            {/* 220 = the real pie canvas size (allocation-pie). */}
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

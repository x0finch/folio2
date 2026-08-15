import { Card, CardContent, CardHeader, Skeleton } from "@folio/ui";

// 跨页共用 / 非首页的骨架。账户页骨架跟那一页走(见 `-accounts/`)。
const CARDS_2 = ["c1", "c2"];

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

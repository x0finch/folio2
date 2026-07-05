import { createFileRoute } from "@tanstack/react-router";

// 洞察页占位(D06 填充:组合走势 + 分配饼图 + 维度切换)。先建路由让侧栏"洞察"可达。
export const Route = createFileRoute("/_authed/insights")({
  component: Insights,
});

function Insights() {
  return <p className="text-muted-foreground text-sm">Insights — coming soon.</p>;
}

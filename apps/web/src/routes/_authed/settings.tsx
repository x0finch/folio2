import { createFileRoute } from "@tanstack/react-router";
import {
  dataStatsQuery,
  providerKeyStatusQuery,
  valuationSettingsQuery,
} from "../../lib/queries/settings";
import { Settings } from "./-settings";

export const Route = createFileRoute("/_authed/settings")({
  // 设置域的读取已迁 react-query(ADR 0038):loader 只预取,组件从缓存读。
  // #495 票 3:三条都发出即返回,快卡不等它们。
  loader: ({ context: { queryClient } }) => {
    queryClient.ensureQueryData(providerKeyStatusQuery());
    queryClient.ensureQueryData(valuationSettingsQuery());
    queryClient.ensureQueryData(dataStatsQuery());
  },
  component: Settings,
});

import { createFileRoute } from "@tanstack/react-router";
import {
  dataStatsQuery,
  providerKeyStatusQuery,
  valuationSettingsQuery,
} from "../../lib/queries/settings";
import { Settings } from "./-settings";

export const Route = createFileRoute("/_authed/settings")({
  // 设置域的读取已迁 react-query(ADR 0038):loader 只预取,组件从缓存读。
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.ensureQueryData(providerKeyStatusQuery()),
      queryClient.ensureQueryData(valuationSettingsQuery()),
      queryClient.ensureQueryData(dataStatsQuery()),
    ]);
  },
  component: Settings,
});

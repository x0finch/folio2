import type { LocaleMessages } from "@folio/ui/lib/i18n";
import type { messages } from "./messages";

// beUI's own strings (mostly what a screen reader hears from a chart), by its component namespace.
// English is beUI's built-in default, so only other locales are listed.
export const BEUI_MESSAGES: Record<keyof typeof messages, LocaleMessages> = {
  en: {},
  zh: {
    xyChart: {
      noData: "暂无数据",
      missing: "无数据",
      dataCaption: "{label}数据",
      category: "类别",
      total: "合计",
      series: "系列",
      seriesValue: "{name} {value}",
      totalValue: "合计 {value}",
    },
    lineChart: {
      label: "折线图",
      loading: "正在加载数据",
      loadingStatus: "加载中",
      inspect: "{label}:查看数值",
    },
    sparkline: {
      inspect: "{label}:查看各点",
      sample: "第 {index} 个点",
      sampleValue: "{name}:{value}",
      range: "从 {first} 到 {last}",
      up: "上涨 {percent}%",
      down: "下跌 {percent}%",
    },
    donutChart: {
      label: "环形图",
      total: "合计",
    },
  },
};

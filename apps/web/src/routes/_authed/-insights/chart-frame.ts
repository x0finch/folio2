// 走势图的画框尺寸。单独一个文件:洞察页的首访骨架(`-page-skeletons`,首包)也要画同一个框,
// 而图本身(recharts)住在洞察那个懒加载 chunk 里 —— 从图组件引这个常量会把整个 chunk 拖进首包。
export const CHART_FRAME = "h-[220px] w-full";

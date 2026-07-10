import ReactMarkdown from "react-markdown";
import { cn } from "../lib/utils";

// provider 拼的 markdown 展示细节直渲(spike markdown-detail)。@tailwindcss/typography 的 prose
// 排印(prose-sm + dark:prose-invert);哑组件,零业务逻辑 —— 加任何 provider 详情前端零改动。
// a 做通用覆盖:所有链接新标签打开 + noopener(全局行为,非按业务 hack)。
// 安全:react-markdown 默认转 React 元素树、不走 dangerouslySetInnerHTML、裸 HTML 转义(未加 rehype-raw)。
export function MarkdownDetail({ md, className }: { md: string; className?: string }) {
  return (
    <div className={cn("prose prose-sm dark:prose-invert max-w-none", className)}>
      <ReactMarkdown
        components={{
          // biome-ignore lint/correctness/noUnusedVariables: strip react-markdown 的 node,余下透传给 <a>
          a: ({ node, ...props }) => <a target="_blank" rel="noopener noreferrer" {...props} />,
        }}
      >
        {md}
      </ReactMarkdown>
    </div>
  );
}

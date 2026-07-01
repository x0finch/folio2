// 命中高亮的纯逻辑(P7.4.5):把 text 按 query 的(大小写不敏感)匹配切成若干段,
// 每段标 match 与否。渲染层据此包裹高亮 <span>——本函数不含 JSX,便于单测。
export interface Segment {
  text: string;
  match: boolean;
}

// 空 query 或无匹配 → 整段一条(match:false)。匹配可多段(逐次向后查找)。
export function matchSegments(text: string, query: string): Segment[] {
  const q = query.trim().toLowerCase();
  if (!q) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const out: Segment[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      out.push({ text: text.slice(i), match: false });
      break;
    }
    if (idx > i) out.push({ text: text.slice(i, idx), match: false });
    out.push({ text: text.slice(idx, idx + q.length), match: true });
    i = idx + q.length;
  }
  return out.length > 0 ? out : [{ text, match: false }];
}

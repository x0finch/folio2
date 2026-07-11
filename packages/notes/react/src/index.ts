// @folio/notes —— provider 展示 note 的 React 渲染件(note 重设计,两级)。
// <NoteView note={…} formatNumber={…}/> 渲染单个 Note(段首状态 icon + 标题 + content string/rows,行 href 包外链)。
//   · account 级:app 用 beUI BouncyAccordion 组装 —— 遍历 Note[],每段一个 item,item 展开体 = <NoteView>。
//   · balance 级:<NoteBadge note={balance.note}/> —— 副行一个 sm badge(段 icon+标题),click 开 popover 显 <NoteView>。
// 数字 locale 格式化由 app 注入 formatNumber(通用包不直接依赖 use-intl / @folio/fx)。
export { NoteIndicator, type NoteIndicatorProps } from "./note-indicator";
export { NoteIconGlyph, NoteView, type NoteViewProps } from "./note-view";

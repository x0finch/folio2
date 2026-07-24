// provider 展示 note 的 React 渲染件(note 重设计,两级)。原 @folio/notes-react 包,#128 迁入 apps/web
// (ui 包只收 registry 安装件;唯一消费方就是 web 的 holdings-cards)。
// <NoteView note={…} formatNumber={…}/> 渲染单个 Note(段首状态 icon + 标题 + content string/rows,行 href 包外链)。
//   · account 级:app 用 beUI BouncyAccordion 组装 —— 遍历 Note[],每段一个 item,item 展开体 = <NoteView>。
//   · balance 级:<NoteIndicator note={balance.note}/> —— 标题右侧一个小状态 icon,hover 开 popover 显 <NoteView>。
// 数字 locale 格式化由 app 注入 formatNumber(渲染件不直接依赖 use-intl / @folio/fx)。
export { NoteIndicator } from "./note-indicator";
export { NoteIconGlyph, NoteView } from "./note-view";

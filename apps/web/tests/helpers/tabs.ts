// beUI Tabs 的读法:按无障碍关系认,不数 DOM 层级。
//
// · 标签文字:每个 tab 里除了真标签,还叠了一份 `aria-hidden` 的副本(选中态的颜色擦除动画),
//   直接读 `textContent` 会读到两遍 —— 只算屏幕阅读器读得到的那份。
// · 面板:`role="tabpanel"` 经 `aria-labelledby` 指回它的 tab。

export function tabLabel(tab: Element): string {
  const clone = tab.cloneNode(true) as Element;
  for (const h of clone.querySelectorAll('[aria-hidden="true"]')) h.remove();
  return clone.textContent?.trim() ?? "";
}

export function tabPanel(tab: Element): HTMLElement {
  return document.querySelector(`[role="tabpanel"][aria-labelledby="${tab.id}"]`) as HTMLElement;
}

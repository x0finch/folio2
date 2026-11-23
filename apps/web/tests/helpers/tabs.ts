// Read beUI Tabs via a11y relations. Each tab stacks an `aria-hidden` copy of its label (for the
// selection animation), so only the accessible text counts.

export function tabLabel(tab: Element): string {
  const clone = tab.cloneNode(true) as Element;
  for (const h of clone.querySelectorAll('[aria-hidden="true"]')) h.remove();
  return clone.textContent?.trim() ?? "";
}

export function tabPanel(tab: Element): HTMLElement {
  return document.querySelector(`[role="tabpanel"][aria-labelledby="${tab.id}"]`) as HTMLElement;
}

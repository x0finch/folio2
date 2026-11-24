// React renderers for provider display notes: <NoteView> renders one Note, <NoteIndicator> is the
// balance-level icon with a hover popover. Number formatting is injected via formatNumber so this
// doesn't depend on use-intl / @folio/fx.
export { NoteIndicator } from "./note-indicator";
export { NoteIconGlyph, NoteView } from "./note-view";

# Design

Rules for every screen in `apps/web`. Desktop and back-office pages follow all five sections; a phone-only page skips "Desktop multi-level menus" in section 4.

## 1. Layout and information
- No box inside a box: no nested cards, no extra divider lines.
- No slogans, subtitles, secondary labels or explanatory copy.
- Hierarchy comes from alignment and spacing, never from text that explains the interface.

## 2. Colour and whitespace
- Minimal, in the manner of apple.com.
- 90% of the surface is neutral (black, white, grey); 10% is one accent colour, kept for the primary action or the key figure.
- No gradients, saturated or neon colours, or heavy card shadows.
- Contrast by weight and lightness: titles bolder and darker, body lighter and thinner.
- Whitespace is 1.5× a conventional page, inside and around components. Leave it empty rather than fill it.

## 3. Type, grid and icons
- Font: Geist everywhere (`--font-sans`).
- Title: 18px, weight 600 or 700. Body: 16px or 14px, weight 400 or 500.
- Text: primary `#181818`, secondary `#6A6A6A`.
- Spacing: multiples of 4px, no exceptions.
- Radius: 8px to 40px by size and level (small button small, large modal large).
- Icons: [Reicon](https://reicon.dev/docs) via `reicon-react`, `weight="Outline"`. Glyph 18px with a 1.5px line, centred in a transparent 24 × 24px box. `strokeWidth` is in 24px-grid units and scales with `size`, so an 18px glyph needs `strokeWidth={2}` to render 1.5px.
- These values live as design tokens in `packages/ui/src/styles/globals.css`; components use the tokens, never the raw values.

## 4. Interaction
- Show controls by intent: secondary actions stay hidden until the pointer hovers, focus lands, scrolling brings the region near, or the user starts acting on it. They must stay reachable by keyboard and touch.

### Desktop multi-level menus
- Open delay, close delay and a safe triangle, all three.
- Safe triangle: while the pointer travels from parent item A toward submenu B, the triangle is the pointer position plus the top and bottom corners of B's near edge. Inside it, B stays open and items passed on the way don't take over.
- beUI's Dropdown Menu already keeps submenus open on a diagonal path; use it rather than building one.

## 5. Components
- beUI only (`pnpm dlx shadcn@latest add @beui/<name>`); never edit its internals.
- Before using or choosing a component, read its page on [beui.dev](https://beui.dev/components/motion). Don't work from memory of its name, props or behaviour.
- When beUI has no such component, compose it from beUI components already there. No other source.

## 6. Acceptance
- The rendered page in a real browser is the truth, not computed style values.
- After every change, look at the actual screen: alignment, wrapping, whitespace and overlap.

import { Popover, PopoverContent, PopoverTrigger } from "@folio/ui";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

// The beUI popover panel's background was painted only by the goo SVG-filter layer, which WebKit
// renders translucent (Chromium-only e2e misses it). The content layer now carries bg-popover itself;
// this pins it so a re-pull of the frozen fork from the registry cannot silently drop it.
describe("beUI popover panel has its own opaque background", () => {
  it("PopoverContent renders a panel with solid bg-popover", () => {
    const { container } = render(
      <Popover open>
        <PopoverTrigger>
          <button type="button">trigger</button>
        </PopoverTrigger>
        <PopoverContent>panel body</PopoverContent>
      </Popover>,
    );
    const panel = container.querySelector('[role="dialog"]');
    expect(panel, "popover panel (role=dialog) should render").not.toBeNull();
    expect(
      panel?.className,
      "panel must carry its own opaque background, not rely on the goo layer (translucent on WebKit)",
    ).toContain("bg-popover");
  });
});

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShellSkeleton } from "@/components/app-shell";

// The skeleton shell is the only thing the server renders, and its value is zero data: the free tier
// gives 10ms CPU per request. Rendering with no providers is the assertion — a hook added to the shell throws here.
describe("<AppShellSkeleton>", () => {
  it("renders with no providers and is a skeleton: grey bars + brand row, no numbers", () => {
    const { container } = render(<AppShellSkeleton />);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    // Brand row twice (desktop sidebar + mobile top bar), same <Brand> as the real shell.
    expect(container.querySelectorAll("svg[aria-label='folio']").length).toBe(2);
    // Nav labels belong to the real shell; this proves AppShell wasn't rendered inside the skeleton.
    expect(container.textContent).not.toContain("Overview");
  });
});

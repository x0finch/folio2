import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SectionList } from "@/routes/_authed/-home/holdings/section-list";

describe("SectionList", () => {
  it("sorted by subtotal descending, first section without a header, later ones with, empty sections omitted", () => {
    const { container, queryByText } = render(
      <SectionList
        sections={[
          { key: "tokens", title: "Tokens", subtotal: 100, count: 2, content: <div>tok</div> },
          { key: "perps", title: "Perps", subtotal: 500, count: 1, content: <div>perp</div> },
          { key: "defi", title: "DeFi", subtotal: 0, count: 0, content: <div>defi</div> },
        ]}
      />,
    );
    const headers = [...container.querySelectorAll("span")]
      .map((el) => el.textContent)
      .filter((txt) => txt === "Tokens" || txt === "Perps" || txt === "DeFi");
    expect(headers).toEqual(["Tokens"]);
    expect(queryByText("defi")).toBeNull();
    expect(queryByText("perp")).not.toBeNull();
    expect(queryByText("tok")).not.toBeNull();
  });

  it("all empty: renders nothing", () => {
    const { container } = render(
      <SectionList
        sections={[{ key: "tokens", title: "Tokens", subtotal: 0, count: 0, content: <div /> }]}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});

import { cleanup, render } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it } from "vitest";
import { AccountName } from "@/components/account-name";
import { NoteView } from "@/components/notes";
import { PageHeader } from "@/components/page-header";
import { ValueDelta } from "@/routes/_authed/-home/holdings/value-delta";

afterEach(cleanup);

//
function withIntl(node: React.ReactNode) {
  return render(
    <IntlProvider locale="en" messages={{}} timeZone="UTC" now={new Date(0)}>
      {node}
    </IntlProvider>,
  );
}

describe("long press: shell not selectable, content selectable", () => {
  it("amount block is selectable", () => {
    const { container } = withIntl(<ValueDelta value={1234.5} delta={-12} pct={0.4} />);
    expect(container.querySelector(".select-text")).not.toBeNull();
  });

  it("account name is selectable", () => {
    const { container } = render(<AccountName name="ryan" />);
    expect(container.querySelector(".select-text")).not.toBeNull();
  });

  it("note body is selectable", () => {
    const { container } = render(
      <NoteView note={{ icon: "info", title: "未确认", content: "3 笔待确认" }} />,
    );
    expect(container.querySelector(".select-text")).not.toBeNull();
  });

  it("page header title is shell: not selectable", () => {
    const { container } = render(<PageHeader title="Overview" subtitle="4 个账户" />);
    expect(container.querySelector("h1")?.closest(".select-none")).not.toBeNull();
  });
});

import type { Tag } from "@folio/db";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "@/lib/i18n/messages";

// 打标签弹窗的乐观层(#428 片 4)。四条写从 `.then().catch()` 换成了 mutation,而这套
// 「点即生效不闪」的 overlay 是 #415 里逐帧调出来的 —— 换发起方式时最容易被悄悄改坏的就是它。
//
// 所以这份测的不是「调没调对 server fn」,是**乐观发生在哪一刻、失败之后回没回去**:
// ① 点一下,在服务端还没回来的时候界面就得已经变了(不是等 refresh);
// ② 失败要把那一格放回原样,而不是留着一个假的「已打上」;
// ③ 新建的占位 chip 同理;
// ④ **create 成功但 attach 失败**这条中间路径,要同时撤掉占位与那笔乐观挂载 ——
//    少撤后者,chip 会永远显示「已打上」,把「你可以手动再挂一次」这条退路挡死。
const { attachTag, detachTag, createTag, renameTag, deleteTag, toastError } = vi.hoisted(() => ({
  attachTag: vi.fn(),
  detachTag: vi.fn(),
  createTag: vi.fn(),
  renameTag: vi.fn(),
  deleteTag: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/server/tags", () => ({
  attachTag,
  detachTag,
  createTag,
  renameTag,
  deleteTag,
}));
vi.mock("@folio/ui", async (orig) => ({
  ...(await orig<object>()),
  toast: { error: toastError, success: vi.fn() },
}));

const { AccountTagsModal } = await import("@/components/account-tags-modal");

const tag = (id: string, name: string): Tag =>
  ({ id, name, portfolioId: "p1", createdAt: 0 }) as unknown as Tag;

const TAGS = [tag("t1", "longterm"), tag("t2", "cold")];

function mount(attachedTagIds: string[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(0)}>
        <AccountTagsModal
          accountId="a1"
          accountLabel="my wallet"
          portfolioId="p1"
          portfolioTags={TAGS}
          attachedTagIds={attachedTagIds}
          tagAccountCounts={{ t1: 1, t2: 1 }}
          open
          onClose={vi.fn()}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
  // chip 的「已打上」在 DOM 上就是那一格的 aria-pressed(见 TagInput)。
  const chip = (name: string) =>
    [...document.querySelectorAll("[aria-pressed]")].find((e) =>
      e.textContent?.includes(`#${name}`),
    ) as HTMLElement | undefined;
  const attached = (name: string) => chip(name)?.getAttribute("aria-pressed") === "true";
  const input = () => document.querySelector("input") as HTMLInputElement;
  const names = () =>
    [...document.querySelectorAll("[aria-pressed]")].map((e) => e.textContent?.trim() ?? "");
  return { ...utils, chip, attached, input, names };
}

// 一个永不 resolve 的调用:用来把「服务端还没回来」这一刻定住。
const neverResolves = () => new Promise(() => {});

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("打标签弹窗的乐观层", () => {
  it("点一下就已经打上了 —— 不等服务端回来", async () => {
    attachTag.mockImplementation(neverResolves);
    const { chip, attached } = mount([]);
    expect(attached("longterm")).toBe(false);

    fireEvent.click(chip("longterm") as HTMLElement);

    // 同一个同步流程里就该已经变了(onMutate 是在第一个 await 之前被调用的)。
    // 这一句必须是**同步**的:改成 await 就测不出「点即生效」,只测出「最终会生效」。
    expect(attached("longterm")).toBe(true);
    // server fn 反而是异步才发出的(mutationFn 在 onMutate 之后一个微任务),所以这句要等。
    await waitFor(() =>
      expect(attachTag).toHaveBeenCalledWith({ data: { accountId: "a1", tagId: "t1" } }),
    );
  });

  it("摘标签同理:点完立刻是未打上", async () => {
    detachTag.mockImplementation(neverResolves);
    const { chip, attached } = mount(["t1"]);
    expect(attached("longterm")).toBe(true);

    fireEvent.click(chip("longterm") as HTMLElement);

    expect(attached("longterm")).toBe(false);
    await waitFor(() => expect(detachTag).toHaveBeenCalled());
  });

  it("打标签失败 → 那一格回到未打上,并报一句", async () => {
    attachTag.mockRejectedValue(new Error("boom"));
    const { chip, attached } = mount([]);

    fireEvent.click(chip("longterm") as HTMLElement);
    expect(attached("longterm")).toBe(true); // 先乐观

    await waitFor(() => expect(attached("longterm")).toBe(false)); // 再回退
    expect(toastError).toHaveBeenCalled();
  });

  it("新建:回车即先摆一个已选中的占位 chip", async () => {
    createTag.mockImplementation(neverResolves);
    const { input, names } = mount([]);

    fireEvent.change(input(), { target: { value: "newtag" } });
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(names().some((n) => n.includes("#newtag"))).toBe(true);
    await waitFor(() =>
      expect(createTag).toHaveBeenCalledWith({ data: { portfolioId: "p1", name: "newtag" } }),
    );
  });

  it("新建失败 → 占位撤掉", async () => {
    createTag.mockRejectedValue(new Error("boom"));
    const { input, names } = mount([]);

    fireEvent.change(input(), { target: { value: "newtag" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(names().some((n) => n.includes("#newtag"))).toBe(true);

    await waitFor(() => expect(names().some((n) => n.includes("#newtag"))).toBe(false));
    expect(toastError).toHaveBeenCalled();
  });

  // 这条是整份文件最该在的一条:建出来了、没挂上。
  it("建成功但挂失败 → 占位撤掉,那笔乐观挂载也撤掉(不能留个假的已打上)", async () => {
    createTag.mockResolvedValue({ id: "t3", name: "newtag" });
    attachTag.mockRejectedValue(new Error("boom"));
    const { input, names, attached } = mount([]);

    fireEvent.change(input(), { target: { value: "newtag" } });
    fireEvent.keyDown(input(), { key: "Enter" });

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // 占位没了,列表回到两条既有 Tag,而且没有任何一格因为那笔乐观挂载而显示成已打上。
    expect(names().some((n) => n.includes("#newtag"))).toBe(false);
    expect(attached("longterm")).toBe(false);
    expect(attached("cold")).toBe(false);
  });

  it("删除:确认后立刻从列表消失;失败则放回去", async () => {
    deleteTag.mockRejectedValue(new Error("boom"));
    const { getByText } = mount([]);

    // 删除在「管理」页:先切过去,点那一行的垃圾桶,再点二次确认的勾。
    fireEvent.click(getByText(messages.en.Tags.manage));
    // 管理页每行是一个 input(可改名),行在不在就看它的 value 在不在。
    const rowNames = () =>
      [...document.querySelectorAll("input")].map((i) => (i as HTMLInputElement).value);
    expect(rowNames()).toContain("cold");

    const trash = [...document.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === `${messages.en.Common.delete} cold`,
    );
    if (!trash) throw new Error("找不到 #cold 的删除按钮");
    fireEvent.click(trash); // 进二次确认(这一行此刻换成确认条,没有 input)
    const confirm = [...document.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === messages.en.Common.delete,
    );
    if (!confirm) throw new Error("找不到二次确认按钮");

    fireEvent.click(confirm);
    expect(rowNames()).not.toContain("cold"); // 即时消失

    await waitFor(() => expect(rowNames()).toContain("cold")); // 失败 → 放回去
    expect(toastError).toHaveBeenCalled();
  });
});

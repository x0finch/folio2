import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// `<TokenRowContent>` 有**三条**渲染路径,而 24h 盈亏(ADR 0040)是靠调用方逐个传进去的:
//   · token-holdings —— 首页 Tokens 视图
//   · holdings-cards —— 账户抽屉里非 manual 账户的现货区
//   · manual-tokens-panel —— 账户抽屉里 **manual 账户**的 Tokens tab(单独一条路,最容易漏)
//
// 漏传的后果是**静默的**:`gain24h` 缺席 → `undefined` → `ValueDelta` 整行不渲染增量,
// 看起来像「这类账户没有这个功能」,而不是像一个 bug。#447 第 5、6 片就漏了第三条,
// 逐处核对也没抓到(核的是前两条),最后是浏览器实测才看见。
//
// 这条测试是**结构性**的:它不验数字对不对(那是 gain-24h / overview-model / account-holdings
// 那几组的事),只验「没有哪条路径把这个字段忘了」——包括将来新增的第四条。
//
// 勾兑:`icon-button-round.test.ts` 是同一种源码扫描形状。

const COMPONENTS = join(import.meta.dirname, "../src/components");
const HOME = join(import.meta.dirname, "../src/routes/_authed/-home");

function filesRendering(tag: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const dir of [COMPONENTS, HOME]) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".tsx")) continue;
      const text = stripLineComments(readFileSync(join(dir, name), "utf8"));
      if (text.includes(`<${tag}`)) out.push({ file: name, text });
    }
  }
  return out;
}

// 行注释先剥掉 —— 这些文件的注释里也会写 `<TokenRowContent>` 指代那个组件,扫进来就是误报。
function stripLineComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const i = line.indexOf("//");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

// `<TokenRowContent ... />` 那一段(到匹配的 `/>` 为止,够覆盖 item={{…}} 整块)。
function renderBlocks(text: string, tag: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  while (true) {
    const start = text.indexOf(`<${tag}`, from);
    if (start === -1) break;
    const end = text.indexOf("/>", start);
    blocks.push(text.slice(start, end === -1 ? text.length : end));
    from = start + 1;
  }
  return blocks;
}

describe("每条 <TokenRowContent> 渲染路径都得把 24h 盈亏传进去", () => {
  const users = filesRendering("TokenRowContent");

  it("三条路径都在(少了说明改动漏了这条测试的前提)", () => {
    expect(users.map((u) => u.file).sort()).toEqual([
      "holdings-cards.tsx",
      "manual-tokens-panel.tsx",
      "token-holdings.tsx",
    ]);
  });

  it.each(users.map((u) => u.file))("%s 传了 gain24h", (file) => {
    const { text } = users.find((u) => u.file === file) as (typeof users)[number];
    for (const block of renderBlocks(text, "TokenRowContent")) {
      expect(block, `${file} 的 <TokenRowContent> 少传 gain24h`).toContain("gain24h");
    }
  });

  it("而且不能用 `?? null` 把三态压平", () => {
    // `undefined`(归档:不该有这个数,整行省略)与 `null`(算不出,画 `—`)在界面上是两种意思。
    // 传参处一个 `?? null` 就把前者变成后者 —— 这个错在 #447 里犯过一次。
    for (const { file, text } of users) {
      for (const block of renderBlocks(text, "TokenRowContent")) {
        expect(block.replace(/\s+/g, " "), `${file} 把 gain24h 的三态压平了`).not.toMatch(
          /gain24h:\s*[^,}]*\?\?\s*null/,
        );
      }
    }
  });

  it("自测:注释里提到组件名不算渲染点", () => {
    const commented = `// 见 <TokenRowContent> 的说明\nconst x = 1;`;
    expect(stripLineComments(commented)).not.toContain("<TokenRowContent");
  });

  it("自测:这条扫描确实抓得到漏传", () => {
    const bad = `<TokenRowContent item={{ value: 1, amount: 2 }} />`;
    expect(renderBlocks(bad, "TokenRowContent")[0]).not.toContain("gain24h");
    const flattened = `<TokenRowContent item={{ gain24h: b.gain24h ?? null }} />`;
    expect(renderBlocks(flattened, "TokenRowContent")[0].replace(/\s+/g, " ")).toMatch(
      /gain24h:\s*[^,}]*\?\?\s*null/,
    );
  });
});

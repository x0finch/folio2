import { describe, expect, it } from "vitest";
import { readStoredCreds } from "@/lib/server/creds";

// 库里那一列 raw JSON 怎么读(#527 裁定 1)。纯函数,所以在 logic 项目里跑 —— 毫秒级,
// 不必为它启一个 workerd。「坏行怎么在页面上表现」那半在 tests/server/accounts/list.cases.ts。
describe("readStoredCreds", () => {
  it("正常的 map → 原样读出来", () => {
    expect(readStoredCreds(JSON.stringify({ apiKey: "k", secret: "密文" }))).toEqual({
      apiKey: "k",
      secret: "密文",
    });
  });

  it("null / 空串(从没填过)→ 空 map,不是 null —— 「没填」和「坏了」是两件事", () => {
    expect(readStoredCreds(null)).toEqual({});
    expect(readStoredCreds(undefined)).toEqual({});
    expect(readStoredCreds("")).toEqual({});
  });

  it("解不开的 JSON → null,不抛", () => {
    expect(readStoredCreds("{这不是 JSON")).toBeNull();
    expect(readStoredCreds("{")).toBeNull();
  });

  it("合法但不是对象的 JSON → 也算解不开", () => {
    // 这几个 parse 得过,但当 map 用会读出一堆 undefined —— 比抛出来更难查。
    expect(readStoredCreds('"就是个字符串"')).toBeNull();
    expect(readStoredCreds("123")).toBeNull();
    expect(readStoredCreds("null")).toBeNull();
    expect(readStoredCreds("[]")).toBeNull();
  });
});

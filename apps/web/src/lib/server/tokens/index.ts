import { createServerFn } from "@tanstack/react-start";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { handleListTokenCatalogue } from "./catalogue";
import { handleListTokens, ListTokensInput } from "./list";
import { handleListFiatOptions } from "./list-fiat-options";
import { handleGetTokenPrice, TokenPriceInput } from "./price";
import { handleRefreshTokenPrices, RefreshTokenPricesInput } from "./refresh-prices";

// 选币的 server fn 资源面(#202b:整条搬到新参考层)。只做装配,实现与入参 schema 在同目录 RESTful 文件里。
//
// **点中不建行。** 读端点都只是读:发目录、搜长尾、取价。代币行是提交表单时由 mint 建的 —— 用户在
// 下拉里划过十个币不该在库里留十行垃圾。因此这里给出去的不是内部 id(那时还没有),
// 而是一张**票**:base64url 编过的 tokenRef,前端原样搬运(红线见 tokens/model.ts 的 `TokenOption`)。

export const listTokenCatalogue = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(runEffect(handleListTokenCatalogue));

// requireAuth 与其余选币端点一致(只在 authed 加账户模态里调)。
export const listFiatOptions = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(runEffect(handleListFiatOptions));

export const listTokens = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(ListTokensInput)
  .handler(runEffect(handleListTokens));

export const getTokenPrice = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(TokenPriceInput)
  .handler(runEffect(handleGetTokenPrice));

export const refreshTokenPrices = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(RefreshTokenPricesInput)
  .handler(runEffect(handleRefreshTokenPrices));

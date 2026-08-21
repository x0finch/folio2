import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "../session/require-auth";
import { handleListTokenCatalogue } from "./catalogue";
import { handleListFiatOptions } from "./list-fiat-options";
import { handleListTokens } from "./list";
import { handleGetTokenPrice } from "./price";
import { handleRefreshTokenPrices } from "./refresh-prices";

// 选币的 server fn 资源面(#202b:整条搬到新参考层)。只做装配,实现在同目录 RESTful 文件里。
//
// **点中不建行。** 读端点都只是读:发目录、搜长尾、取价。代币行是提交表单时由 mint 建的 —— 用户在
// 下拉里划过十个币不该在库里留十行垃圾。因此这里给出去的不是内部 id(那时还没有),
// 而是一张**票**:base64url 编过的 tokenRef,前端原样搬运(红线见 tokens/model.ts 的 `TokenOption`)。

export const listTokenCatalogue = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(handleListTokenCatalogue);

// requireAuth 与其余选币端点一致(只在 authed 加账户模态里调)。
export const listFiatOptions = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(handleListFiatOptions);

export const listTokens = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ query: z.string() }))
  .handler(handleListTokens);

export const getTokenPrice = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ ticket: z.string().min(1) }))
  .handler(handleGetTokenPrice);

export const refreshTokenPrices = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(z.object({ tickets: z.array(z.string().min(1)).max(200) }))
  .handler(handleRefreshTokenPrices);

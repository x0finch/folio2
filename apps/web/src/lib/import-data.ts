import type { ImportCounts } from "./import";

// 客户端 → 自家 `/api/import` 的一次性上传(纯传输层,不含 React,可复用/可测)。
//
// **走路由而非 server function**:传的是文件本体(`body: file`),二进制塞进 server function 得先
// base64,不划算 —— 路由能直接把 `Request.body` 交给服务端(#241)。
// **失败把服务端的纯文本错误原样抛出**:调用方(useMutation 的 error)拿到的就是它,直接显给用户。
// **不在这里重试**:重传文件该由用户重选,不该自动发第二发。
export interface ImportResult {
  imported: ImportCounts;
}

export async function importData(file: File): Promise<ImportResult> {
  const res = await fetch("/api/import", { method: "POST", body: file });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<ImportResult>;
}

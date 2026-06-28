import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "../require-auth";

// 全局 provider key 是否已配置(只回布尔,绝不回值)。自托管者据此自检 env。
// CEX 用每账户密钥、非全局 key,故不在此列。
export const getKeyStatus = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(() => ({
    ZERION_API_KEY: Boolean(env.ZERION_API_KEY),
    COINSTATS_API_KEY: Boolean(env.COINSTATS_API_KEY),
  }));

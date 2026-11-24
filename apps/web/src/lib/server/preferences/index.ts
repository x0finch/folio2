import { createServerFn } from "@tanstack/react-start";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { CurrencyPreferenceInput, handleGetCurrencyPreference } from "./currency";

// Currency and language live in the browser; the only server-side piece is the per-user FX rate, hence requireAuth.
export const getCurrencyPreference = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(CurrencyPreferenceInput)
  .handler(runEffect(handleGetCurrencyPreference));

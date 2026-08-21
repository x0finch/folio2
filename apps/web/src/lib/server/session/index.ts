import { createServerFn } from "@tanstack/react-start";
import { handleGetSession } from "./get";

export const getSession = createServerFn({ method: "GET" }).handler(handleGetSession);

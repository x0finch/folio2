import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { ConnectorRegistry } from "./registry";

// Both handlers just read a field off the ticket, so they're inlined. `registry` imports cloudflare:workers only
// inside handler bodies, which the createServerFn compile strips, so this file is client-safe.

// connectorId -> {label, logo}, consumed by `connectorCatalogQuery`.
export const listConnectors = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(
    runEffect(
      Effect.fn("listConnectors")(function* () {
        return (yield* ConnectorRegistry).catalog;
      }),
    ),
  );

// Per-connector account input specs, used to build entry / completion forms dynamically.
export const getConnectorCredentialSpecs = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(
    runEffect(
      Effect.fn("getConnectorCredentialSpecs")(function* () {
        return (yield* ConnectorRegistry).specs;
      }),
    ),
  );

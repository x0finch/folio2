import { queryOptions } from "@tanstack/react-query";
import { getConnectorCredentialSpecs, listConnectors } from "@/lib/server/connectors";
import { STALE_TIME } from "./constants";
import { connectorKeys } from "./keys";

// No writes in this domain: both results derive from the registry and can't change within a
// deployment, hence the longest stale time and no refresh-map entry.

export const connectorCatalogQuery = () =>
  queryOptions({
    queryKey: connectorKeys.catalogue(),
    queryFn: () => listConnectors(),
    staleTime: STALE_TIME.deployment,
  });

export const connectorCredentialSpecsQuery = () =>
  queryOptions({
    queryKey: connectorKeys.credentialSpecs(),
    queryFn: () => getConnectorCredentialSpecs(),
    staleTime: STALE_TIME.deployment,
  });

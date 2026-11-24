import { Effect } from "effect";
import { ConnectorRegistry } from "@/lib/server/connectors/registry";
import type { InputSpec } from "@/lib/server/creds";

// Stand-in for the connector service so credential-validation branches (bad shape / probe failed /
// upstream flake) are test inputs, not live calls. Field specs stay real by default: they drive which
// fields get encrypted.

export const realRegistry = (): Promise<ConnectorRegistry["Service"]> =>
  Effect.runPromise(Effect.provide(ConnectorRegistry, ConnectorRegistry.layer));

export interface FakeRegistryOptions {
  /** Result of the probe/shape check. Defaults to pass. */
  readonly validate?: (
    connectorId: string,
    values: Record<string, string>,
    opts?: { liveness?: boolean; label?: string },
  ) => Effect.Effect<void, Error>;
  readonly specs?: Partial<Record<string, InputSpec[]>>;
  readonly catalog?: Record<string, { label: string; logo: string }>;
}

/** Records each `validate` input: on the probe-failure path nothing is persisted to inspect. */
export const fakeRegistry = async (
  options: FakeRegistryOptions = {},
): Promise<{
  registry: ConnectorRegistry["Service"];
  validated: Array<Record<string, string>>;
}> => {
  const real = await realRegistry();
  const validated: Array<Record<string, string>> = [];
  const registry = {
    catalog: options.catalog ?? real.catalog,
    specs: options.specs ?? real.specs,
    validate: (
      connectorId: string,
      values: Record<string, string>,
      opts?: { liveness?: boolean; label?: string },
    ) => {
      validated.push({ ...values });
      return options.validate
        ? options.validate(connectorId, values, opts)
        : (Effect.void as Effect.Effect<void, Error>);
    },
  } as ConnectorRegistry["Service"];
  return { registry, validated };
};

export const validateFails = (message: string) => () =>
  Effect.fail(new Error(message)) as Effect.Effect<void, Error>;

import { getRouteApi } from "@tanstack/react-router";
import { StaggerReveal } from "@/components/page-switcher/stagger-reveal";
import { AppearanceCard } from "./appearance-card";
import { DataCard } from "./data-card";
import { PasskeysCard } from "./passkey";
import { AutoLockCard } from "./passkey/auto-lock-card";
import { ProviderKeysCard } from "./provider-keys-card";
import { UserCard } from "./user-card";
import { ValuationCard } from "./valuation-card";

const authedApi = getRouteApi("/_authed");

export function Settings() {
  const { user } = authedApi.useRouteContext();
  return (
    <StaggerReveal className="flex flex-col gap-6">
      <UserCard user={user} />
      <AppearanceCard />
      {/* Before passkeys: passkeys are now added only via the auto-lock toggle. */}
      <AutoLockCard />
      <PasskeysCard />
      <ProviderKeysCard />
      <ValuationCard />
      <DataCard />
      <p className="pt-2 text-center font-mono text-muted-foreground text-xs">
        {/* Shallow CI clones have no tag, so version == commit; avoid printing it twice. */}
        {__APP_VERSION__ !== __COMMIT_HASH__ ? `${__APP_VERSION__} · ` : ""}
        {__COMMIT_HASH__} · {__BUILD_TIME__.slice(0, 10)}
      </p>
    </StaggerReveal>
  );
}

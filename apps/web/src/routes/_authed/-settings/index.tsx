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
    <StaggerReveal
      className="flex flex-col divide-y divide-border"
      itemClassName="py-12 first:pt-0 last:pb-0"
    >
      <UserCard user={user} />
      <AppearanceCard />
      {/* Before passkeys: passkeys are now added only via the auto-lock toggle. */}
      <AutoLockCard />
      <PasskeysCard />
      <ProviderKeysCard />
      <ValuationCard />
      <DataCard />
    </StaggerReveal>
  );
}

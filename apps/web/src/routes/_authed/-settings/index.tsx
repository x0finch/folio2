import { getRouteApi } from "@tanstack/react-router";
import { AppearanceCard } from "./appearance-card";
import { DataCard } from "./data-card";
import { PasskeysCard } from "./passkey";
import { AutoLockCard } from "./passkey/auto-lock-card";
import { ProviderKeysCard } from "./provider-keys-card";
import { UserCard } from "./user-card";
import { ValuationCard } from "./valuation-card";

const authedApi = getRouteApi("/_authed");

// 设置页(S1,#112)。卡片顺序:用户 → 外观 → 自动锁 → Passkey → Provider key → 估值 → 数据。
export function Settings() {
  const { user } = authedApi.useRouteContext();
  return (
    <div className="flex flex-col gap-6">
      <UserCard user={user} />
      <AppearanceCard />
      {/* 自动锁定在 passkeys 之前:passkey 现在只从这里添加(开关首次打开时注册一个本机凭据)。 */}
      <AutoLockCard />
      <PasskeysCard />
      <ProviderKeysCard />
      <ValuationCard />
      <DataCard />
      <p className="pt-2 text-center font-mono text-muted-foreground text-xs">
        {/* 有 tag 时 __APP_VERSION__ 是版本号、与 commit 不同则一起显示;CI 浅克隆无 tag 时两者
            相同,只显示 commit,避免 `hash · hash` 的重复。 */}
        {__APP_VERSION__ !== __COMMIT_HASH__ ? `${__APP_VERSION__} · ` : ""}
        {__COMMIT_HASH__} · {__BUILD_TIME__.slice(0, 10)}
      </p>
    </div>
  );
}

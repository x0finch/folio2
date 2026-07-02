import {
  type Account,
  type AccountType,
  type Balance,
  type BalanceProvider,
  type FetchContext,
  validateCredentials as runValidators,
} from "@folio/balances-basic";
import { buildRegistry, getProvider, type ProviderRegistry, registry } from "./registry";

// provider.inputs 的可序列化投影(剥掉不可序列化的 validator,客户端只需 key+type+label 渲染)。
export interface InputSpec {
  key: string;
  type: "public" | "semi" | "secret";
  label: string; // 兼作 i18n key(见 ProviderInput.label);desc 同理
  desc?: string;
}

// 活性校验/取数时拼 FetchContext.account 用(建号 id/userId 缺省 "new")。
export interface AccountShell {
  type: AccountType;
  label?: string;
  userId?: string;
  id?: string;
}

export interface CreateBalancesConfig {
  // provider 全局 API key(探活/取数按 usesGlobalKeys 收窄下发)。加密/存储不归本包,故无 secretsKey。
  globalKeys: Record<string, string>;
  // 测试可注入 provider 列表覆盖默认 registry。
  providers?: BalanceProvider[];
}

// 余额侧领域实例 —— 只暴露【必须依赖 provider 实现】的能力:字段声明、跑 validator/探活、调 provider 取数。
// 加密/解密、导出脱敏、导入补录等能从字段 schema 派生的塑形,归业务层(app lib/creds.ts),不在此。
export interface Balances {
  // provider 声明的字段规格(可序列化);业务层据其 type 做 seal/mask/complete/categorize。
  credentialSpecs(): Partial<Record<AccountType, InputSpec[]>>;
  // 按 provider 的 validator 校验形状;opts.liveness 时再 provider.validate 探活。不过则抛。
  validateCredentials(
    shell: AccountShell,
    rawValues: Record<string, string>,
    opts?: { liveness?: boolean },
  ): Promise<void>;
  // 用【明文】creds 取余额:运行时再跑一次 validator 闸 → 拼 ctx(收窄 globalKeys)→ provider.fetchBalances → 汇总。
  fetchBalances(
    account: Account,
    creds: Record<string, string>,
  ): Promise<{ balances: Balance[]; totalUsd: number }>;
}

// 把整张全局 key 表收窄到 provider 声明用到的子集(env 里存在的才下发)—— 最小权限。
function scopeGlobalKeys(
  all: Record<string, string>,
  names: readonly string[] = [],
): Record<string, string> {
  const scoped: Record<string, string> = {};
  for (const name of names) {
    if (name in all) scoped[name] = all[name];
  }
  return scoped;
}

export function createBalances(config: CreateBalancesConfig): Balances {
  const reg: ProviderRegistry = config.providers ? buildRegistry(config.providers) : registry;

  return {
    credentialSpecs() {
      const specs: Partial<Record<AccountType, InputSpec[]>> = {};
      for (const [type, provider] of Object.entries(reg)) {
        if (!provider) continue;
        specs[type as AccountType] = (provider.inputs ?? []).map((i) => ({
          key: i.key,
          type: i.type,
          label: i.label,
          desc: i.desc,
        }));
      }
      return specs;
    },

    async validateCredentials(shell, rawValues, opts) {
      const provider = getProvider(reg, shell.type);
      const creds = await runValidators(provider.inputs ?? [], rawValues); // 形状校验闸(抛)
      if (opts?.liveness) {
        const ctx: FetchContext = {
          account: {
            id: shell.id ?? "new",
            userId: shell.userId ?? "new",
            type: shell.type,
            label: shell.label ?? "",
          },
          creds,
          globalKeys: scopeGlobalKeys(config.globalKeys, provider.usesGlobalKeys),
        };
        if (!(await provider.validate(ctx))) {
          throw new Error("could not verify these credentials — please check them and try again");
        }
      }
    },

    async fetchBalances(account, creds) {
      const provider = getProvider(reg, account.type);
      // 运行时闸:按 validator 校验明文 creds(脏/缺数据 → 抛),通过才进 ctx。
      const validated = await runValidators(provider.inputs ?? [], creds);
      const ctx: FetchContext = {
        account,
        creds: validated,
        globalKeys: scopeGlobalKeys(config.globalKeys, provider.usesGlobalKeys),
      };
      const balances = await provider.fetchBalances(ctx);
      const totalUsd = balances.reduce((sum, b) => sum + b.usdValue, 0);
      return { balances, totalUsd };
    },
  };
}

import {
  type Account,
  type AccountType,
  type Balance,
  type BalanceProvider,
  type FetchContext,
  validateCredentials as runValidators,
} from "@folio/balances-basic";
import { ACCOUNT_TYPE_SPECS } from "@folio/provider-registry";
import { getProvider, type ProviderRegistry, registry } from "./registry";

// ProviderInput 的可序列化投影(剥掉不可序列化的 validator,客户端只需 key+type+label 渲染)。
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
  // 生效 provider 解析(app 注入:覆盖表 + settings 分层 + 工厂实例化,见 ADR 0009)。
  // 返回 undefined = 该 type 未启用/未配置。缺省 = 静态默认 registry(manifest 默认、无 settings)。
  resolveProvider?: (type: AccountType) => Promise<BalanceProvider | undefined>;
  // 测试可注入 type→provider 映射覆盖默认 registry。
  registry?: ProviderRegistry;
}

// 余额侧领域实例。账户输入 schema 归 accountType 数据约束层(ACCOUNT_TYPE_SPECS,ADR 0009 层1);
// provider(层2)只提供取数 + 两个 liveness 校验。加密/脱敏/补录塑形归业务层(app lib/creds.ts)。
export interface Balances {
  // accountType → 账户输入字段规格(可序列化);业务层据其 type 做 seal/mask/complete/categorize。
  credentialSpecs(): Partial<Record<AccountType, InputSpec[]>>;
  // 账户 liveness(输入 5):按层1 validator 校验账户 creds 形状;opts.liveness 时再 provider.validateAccount 探活。
  validateCredentials(
    shell: AccountShell,
    rawValues: Record<string, string>,
    opts?: { liveness?: boolean },
  ): Promise<void>;
  // 配置 liveness(输入 4):校验某 provider 注入 settings 后其全局 config 是否可用(enable/改 key 时)。
  // provider 未声明 validateConfig → 视为通过(仅形状校验,由调用方在 seal 前另做)。返回 false 抛。
  validateProviderConfig(provider: BalanceProvider): Promise<void>;
  // 用【明文】creds 取余额:运行时再跑一次 validator 闸 → 拼 ctx → provider.fetchBalances → 汇总。
  fetchBalances(
    account: Account,
    creds: Record<string, string>,
  ): Promise<{ balances: Balance[]; totalUsd: number }>;
}

// accountType → 账户输入声明(层1)。空 = 未知类型。
function inputsOf(type: AccountType) {
  return ACCOUNT_TYPE_SPECS[type]?.accountInputs ?? [];
}

export function createBalances(config: CreateBalancesConfig = {}): Balances {
  const reg: ProviderRegistry = config.registry ?? registry;
  const active = async (type: AccountType): Promise<BalanceProvider> => {
    if (config.resolveProvider) {
      const provider = await config.resolveProvider(type);
      if (!provider) throw new Error(`No provider enabled for account type: ${type}`);
      return provider;
    }
    return getProvider(reg, type);
  };

  return {
    credentialSpecs() {
      const specs: Partial<Record<AccountType, InputSpec[]>> = {};
      for (const type of Object.keys(ACCOUNT_TYPE_SPECS) as AccountType[]) {
        specs[type] = inputsOf(type).map((i) => ({
          key: i.key,
          type: i.type,
          label: i.label,
          desc: i.desc,
        }));
      }
      return specs;
    },

    async validateCredentials(shell, rawValues, opts) {
      const inputs = inputsOf(shell.type);
      const creds = await runValidators(inputs, rawValues); // 形状校验闸(抛)
      if (opts?.liveness) {
        const provider = await active(shell.type);
        const ctx: FetchContext = {
          account: {
            id: shell.id ?? "new",
            userId: shell.userId ?? "new",
            type: shell.type,
            label: shell.label ?? "",
          },
          creds,
        };
        if (!(await provider.validateAccount(ctx))) {
          throw new Error("could not verify these credentials — please check them and try again");
        }
      }
    },

    async validateProviderConfig(provider) {
      if (!provider.validateConfig) return; // 无 config-liveness 能力 → 略过(形状校验已在别处)
      if (!(await provider.validateConfig())) {
        throw new Error("could not verify this API key — please check it and try again");
      }
    },

    async fetchBalances(account, creds) {
      const provider = await active(account.type);
      // 运行时闸:按层1 validator 校验明文 creds(脏/缺数据 → 抛),通过才进 ctx。
      const validated = await runValidators(inputsOf(account.type), creds);
      const ctx: FetchContext = { account, creds: validated };
      const balances = await provider.fetchBalances(ctx);
      const totalUsd = balances.reduce((sum, b) => sum + b.value, 0);
      return { balances, totalUsd };
    },
  };
}

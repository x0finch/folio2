import {
  type Account,
  type AccountType,
  type Balance,
  type BalanceProvider,
  type FetchContext,
  isComplete,
  openCreds,
  safeView,
  sealCreds,
  validateCredentials,
} from "@folio/balances-basic";
import { buildRegistry, getProvider, type ProviderRegistry, registry } from "./registry";

// 表单字段规格(可序列化投影:剥掉不可序列化的 validator,客户端只需 key+type+label 渲染)。
export interface InputSpec {
  key: string;
  type: "public" | "semi" | "secret";
  label: string; // 兼作 i18n key(见 ProviderInput.label);desc 同理
  desc?: string;
}

// 取余额结果:缺凭据(导入待补录)返回 needs-credentials,不抛;失败(上游/网络)抛 ProviderError。
export type FetchOutcome =
  | { status: "ok"; balances: Balance[]; totalUsd: number }
  | { status: "needs-credentials" };

export interface CreateBalancesConfig {
  secretsKey: string;
  globalKeys: Record<string, string>;
  // 测试可注入 provider 列表覆盖默认 registry(默认用全部 provider 包组装的 registry)。
  providers?: BalanceProvider[];
}

// 余额侧领域实例:只暴露意图方法,内部编排 registry 查找 / creds 校验封装解密 / ctx 拼装 / provider 调用。
// 调用方(app / sync)不碰 getProvider / sealCreds / openCreds / safeView / validateCredentials /
// scopeGlobalKeys / provider.inputs —— 全在实例内。
// 账户外壳:活性校验时拼 FetchContext.account 用(建号 id 缺省 "new")。
export interface AccountShell {
  type: AccountType;
  label: string;
  userId?: string;
  id?: string;
}

export interface Balances {
  // 各 type 的字段规格(可序列化投影),供前端动态渲染录入/补录表单。
  credentialSpecs(): Partial<Record<AccountType, InputSpec[]>>;
  // 某账户存库 creds 的安全投影:public 原样 / semi 打码 / secret 丢(导出、前端展示用)。
  safeCredentials(type: AccountType, stored: Record<string, string>): Record<string, string>;
  // 是否还需补录凭据:非 public 字段未填真值(导入待补录态)。
  needsCredentials(type: AccountType, stored: Record<string, string>): boolean;
  // 校验 →(opts.verify 时)活性校验 → 封装为存库 creds JSON。校验不过 / 活性失败则抛。
  prepareCredentials(
    shell: AccountShell,
    rawValues: Record<string, string>,
    opts?: { verify?: boolean },
  ): Promise<string>;
  // 取余额:缺凭据返回 needs-credentials;成功返回 ok{balances,totalUsd};上游失败抛 ProviderError。
  fetchBalances(account: Account, stored: Record<string, string>): Promise<FetchOutcome>;
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
  const inputsOf = (type: AccountType) => getProvider(reg, type).inputs ?? [];

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

    safeCredentials(type, stored) {
      return safeView(inputsOf(type), stored);
    },

    needsCredentials(type, stored) {
      return !isComplete(inputsOf(type), stored);
    },

    async prepareCredentials(shell, rawValues, opts) {
      const provider = getProvider(reg, shell.type);
      const inputs = provider.inputs ?? [];
      // 校验闸(不合规抛);coerce 输出仅供活性校验的 ctx,封装仍用原始字符串(保持 creds 为字符串 map)。
      const creds = await validateCredentials(inputs, rawValues);
      if (opts?.verify) {
        const ctx: FetchContext = {
          account: {
            id: shell.id ?? "new",
            userId: shell.userId ?? "new",
            type: shell.type,
            label: shell.label,
          },
          creds,
          globalKeys: scopeGlobalKeys(config.globalKeys, provider.usesGlobalKeys),
        };
        if (!(await provider.validate(ctx))) {
          throw new Error("could not verify these credentials — please check them and try again");
        }
      }
      return JSON.stringify(await sealCreds(inputs, rawValues, config.secretsKey));
    },

    async fetchBalances(account, stored) {
      const provider = getProvider(reg, account.type);
      const inputs = provider.inputs ?? [];
      // 缺凭据态(导入待补录:有 semi/secret 字段未填真值)→ 不算失败,补录后下次纳入(P6.6.1)。
      if (!isComplete(inputs, stored)) return { status: "needs-credentials" };
      // 只在此刻解密 secret 字段、用完即弃(openCreds:public/semi 明文原样、secret 解密)。
      const opened = await openCreds(inputs, stored, config.secretsKey);
      const creds = await validateCredentials(inputs, opened); // 运行时闸:脏/缺数据 → 抛
      const ctx: FetchContext = {
        account,
        creds,
        globalKeys: scopeGlobalKeys(config.globalKeys, provider.usesGlobalKeys),
      };
      const balances = await provider.fetchBalances(ctx);
      const totalUsd = balances.reduce((sum, b) => sum + b.usdValue, 0);
      return { status: "ok", balances, totalUsd };
    },
  };
}

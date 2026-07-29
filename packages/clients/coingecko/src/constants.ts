// 限速与重试的数字(原则 #8)。**每个都写出处** —— 猜一个看起来合理的数字然后不留痕迹,
// 比不填更糟:太紧白白变慢(搜索/选币下拉是用户输入时打的),太松等于没装。

// 闸的 key。**取的是环境变量名,绝不是 key 的值** —— key 会进日志属性(见 LimitLogger),
// 而 CGK 的额度是按 key 算的,所以用一个稳定的标识符代表「那把 key」就够了。
// 一把 key 全部署共用:所有用户的每次调用都花同一份额度。
export const CG_LIMIT_KEY = "COINGECKO_API_KEY";
export const CG_LIMIT_KEY_KEYLESS = "coingecko:keyless"; // 没配 key 时按出口 IP 算,是另一份额度

// —— 配额 ——
// 官方文档(https://docs.coingecko.com/docs/common-errors-rate-limit):
//   · Demo 档(免费 key):**100 calls/min**
//   · 无 key:按 **IP** 限,而且是所有无 key 用户共享,文档不给数
//   · 付费档:随计划不同,文档不列具体数
// 同一页还写明:**4xx / 5xx 也计入配额** —— 所以下面每档都留了余量,不贴着标称值跑。
export const CG_CALLS_PER_MIN_DEMO = 80; // 标称 100,留 20% 给错误响应和窗口边界
export const CG_CALLS_PER_MIN_KEYLESS = 10; // 文档无数字 → 保守值,**未实测**;撞了再调
export const CG_CALLS_PER_MIN_PRO = 400; // 付费档文档只说 varies → 取一个明显保守的;上了 pro 按自己的计划调

// 突发额度。**为什么是 2 而不是 4**:目录预热一次要翻 4 页,而搜索和选币下拉是**用户输入时**打的,
// 两者共享同一个桶。容量给大了,预热能一口气把突发抽干,紧随其后的搜索就得等满一轮;容量压到 2,
// 用户最坏情况的等待也就跟着变短。代价是预热本身慢几秒 —— 它在后台,没人等。
//
// 这也是为什么 fetchMarkets **保持顺序翻页、不要改成并发**:并发发出去闸也是一个个放行,
// 快不起来,只是把突发额度更快地抽干、让前台等得更久。
export const CG_BURST = 2;

// —— 重试 ——
// **1 次重试就够**:目的是躲瞬时抖动,不是硬扛持续限流。配额真耗尽时 Retry-After 会给到几十秒,
// 那种情况按下面的上限直接失败,交给 SWR 顶旧数据。
export const CG_RETRY_ATTEMPTS = 2; // 总尝试次数(1 + 1 重试)
export const CG_RETRY_BASE_MS = 250; // 退避基数,同时是抖动幅度

// 单次等待上限。**为什么是 2 秒**:这条路可能挂在用户的写路径上(mint 冷启动那一次用户在等),
// 而 CGK 免费档的 Retry-After 能给到 60s —— 等下去等于把请求挂死。Workers 上等待烧的是
// wall-clock 不是 CPU,但仍受请求总时长约束,所以上限要按「用户还愿意等多久」定,不是按 CPU 定。
// 超过它就不等了,直接抛(错误上仍带着 retryAfterMs,调用方自己决定降级还是报错)。
export const CG_RETRY_MAX_WAIT_MS = 2000;

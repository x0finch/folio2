import { Context } from "effect";

// **「这次请求是谁的」** —— per-user 服务从这里拿 userId,不再从 layer 参数拿(ADR 0044)。
//
// ADR 0037 那条保证一个字没变:**userId 在装配那一刻被吃掉**。每个 per-user 服务在建自己那一刻
// `yield* CurrentUser` 读一次,绑进闭包;方法签名里仍然一个 user 参数都没有,`R` 也仍然是 `never`。
// 变的只是它从哪儿来 —— 从「每个领域一个 `xxxLayer(userId)` 工厂」变成「整次请求 provide 一次」。
//
// **故意不给默认值**(所以是 `Context.Tag` 而不是 `Context.Reference`):`Reference` 强制要
// `defaultValue`,忘了 provide 不会报错,会静默按默认用户去查 —— 跨用户数据这种地方,忘了就该
// 编译不过。没有默认值时它留在 `R` 通道上,装配点不 provide 就是一个类型错误。
export class CurrentUser extends Context.Tag("db/CurrentUser")<CurrentUser, string>() {}

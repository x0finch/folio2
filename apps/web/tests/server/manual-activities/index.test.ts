// 每个 vitest 文件在 workerd 里都要重新评估整张 app import 图(实测 ~9s/文件,
// 迁移只占 22ms)—— 这版 pool(0.16.x)没有共享模块图的旋钮,唯一的杠杆是少开文件。
// 用例仍按 handler 一个 `.cases.ts` 分文件住,这里只做汇入;各文件的钩子被自己的
// describe 作用域住,互不串。
import "./create.cases";
import "./remove.cases";
import "./update.cases";

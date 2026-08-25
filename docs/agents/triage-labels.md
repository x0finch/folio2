# 分诊 label

技能用五个固定角色说话,这张表把角色对到本仓 issue tracker(**Linear**,team `FOL`)里真正的 label 名。

| 角色              | 本仓 label        | 含义                     |
| ----------------- | ----------------- | ------------------------ |
| `needs-triage`    | `needs-triage`    | 需要先做决策 / 补信息    |
| `needs-info`      | `needs-info`      | 等提问的人补充           |
| `ready-for-agent` | `ready-for-agent` | 已写全,AFK agent 可直接接 |
| `ready-for-human` | `ready-for-human` | 需要人来实现             |
| `wontfix`         | `wontfix`         | 不会做                   |

五个**都已在 `FOL` team 建好**,名字和角色同名 —— 技能里提到某个角色时,直接用同名 label。

## 跟 workflow state 的分工

Linear 有原生 workflow state,别拿 label 重复表达进度:

- **「先不做」不打 label**,挪到 `Backlog` state。(GitHub 时代的 `backlog` label 没有迁过来。)
- **「不做了」**挪到 `Canceled` state。`wontfix` label 保留给需要在列表里一眼看出来的场合,两者可以同时用。
- **`roadmap`** label 标记里程碑级 epic(非竖切片),独立于 state。

## 其他 label

GitHub 上的 `bug` / `enhancement` 迁移时对到了 Linear workspace 自带的 **`Bug`** / **`Improvement`**(注意首字母大写),没有另建小写的。

label **用到再建**,别提前铺。

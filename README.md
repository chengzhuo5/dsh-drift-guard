# Drift Guard

一个零依赖的 Host 插件，治两个同源的失败模式——**agent 悄悄把"被要求的东西"换成"眼下更方便的东西"**：

1. **跑偏**：会话从一个明确请求开始，遇到问题后悄悄把目标换成"眼下正在修的那件事"。
2. **缩水**：交出一个贴着标签的子集就宣称完成——"最小版本"、"后续再做"。运行时同样察觉不到，因为**缺少的那部分从来没被写成"欠着的东西"**。

## 四种机制

| 机制 | 作用 |
|---|---|
| **基线** | 启动当前请求的人类消息，折进 session projection：随 resume/fork 存活、压缩吃不掉、agent 改不了，且**每次请求重新陈述** |
| **契约** | objective / done_when / **must_deliver** / must_preserve / out_of_scope / main_paths / user_decisions / open_direction_decisions |
| **方向变更协议** | 九类方向级变更必须上报，只有用户能批准 |
| **完整性账本** | 每个 must_deliver 项都要有覆盖判定；未完成项**阻止 turn 以自信的口吻关闭** |

其余一切都是**建议性**的（只丰富下一次请求，不否决调用），所以不会把正常工作的会话锁死。

## 一切按「请求」作用域（真实运行抓出来的核心修正）

第一版把这些绑在了**会话**上，真实运行立刻暴露三个 bug：

| Bug | 现象 | 修正 |
|---|---|---|
| 契约跨 turn 累积 | 新请求配着三轮前的旧契约（revision 已到 4） | 契约绑定 `turnKey`（=启动本请求的人类消息 seq）；旧契约进 `contractHistory`，只作上下文、永不执法 |
| 预算按会话步数算 | `64 used / budget 15`，永远超支 → 每轮都发 checkpoint | 预算改用 `stepsThisTurn`（本请求内闭环步数） |
| 推迟措辞误报 | 报了 6 个标记，全来自"讨论机制"的文本 | 只认**明确宣告**的措辞，且要求同句出现工作动词；只读 `source.kind === 'model'` 的 assistant 记录 |

**为什么是"请求"而不是"turn"**：一个 turn 里可能有多次注入（守卫自己的提醒、question 的回答），它们不应各自重置预算；而**人类消息**才是新请求的边界。所以 `turnKey` 取人类消息的 seq。

## 完整性机制（核心一层）

**声明**：`drift_anchor action:"set"` 时列出 `must_deliver[]`——"这次请求要算完成，必须存在哪些东西"。清单随契约写进 transcript。

**记账**：`drift_anchor action:"coverage"` 为每项记判定——`complete` / `partial` / `missing` / `waived`。`partial`/`missing` **没有人类授权就是方向变更**，需要 `drift_report` 拿到明确同意。

**闸门**：turn 即将关闭时只要还有未完成项，就用 `agent.steer()` 强制再走一步，给三个出口：

1. 现在做完，用 `coverage` 记 `complete` 并给证据；
2. 用 `drift_report`（reason `incomplete-delivery`）请用户接受部分交付；
3. 老实停下报告未完成——**不许把部分交付描述成完成，也不许把剩余工作单方面改名成"后续"**。

### 推迟措辞检测：默认关闭（测量结论，不是保守选择）

曾经有一层会扫描 agent 自己的输出，命中中英文的缩减/推迟措辞时记录下来。**它现在默认关闭**，原因是三次真实运行给出了三次同类误报：

| 次数 | 触发文本 | 性质 |
|---|---|---|
| 1 | 守卫自己的政策段（"shipping a labelled subset…"） | 自我误报 |
| 2 | README 被引用 | 引用误报 |
| 3 | 守卫开场语里的 `partial delivery` 被我引用 | 讨论误报 |

我为此加过一次规则（要求**同句出现工作动词**），真实文本立刻换了个方式绕过去。

**结论**：prose 层面的意图信号没有判别力——因为语料里充满了**正在讨论被检测之物**的文本。这与 `dsh-trajectory-anchor` 对自己统计通道测出的结论同形（precision 6.2%，低于 20% 的随机基线）。

它**只记录、从不执法**，所以关掉它只减少噪声、不损失任何能力。代码保留、`reportDeferrals: true` 可重新开启，供任何人用自己的语料重测。

对比之下：**账本是事实**（清单是 agent 声明的、判定是 agent 给的、闸门只核对有没有如实记账），真实运行零问题。**把猜测关掉，把事实留下**，是这一层唯一诚实的取舍。

## 完整性的能力边界（不假装）

- 只核对**声明过**的 `must_deliver`。不声明就没账可查（此时 `set` 的结果会明确提醒）。
- **无法验证 `complete` 是否为真**。要求附 `evidence` 只是把声称与证据绑定，不是验证。
- 判定 `partial`/`missing` 时**总是**记入账本（那是 agent 自己的声明，藏起来只会让账本说谎），但**不会**因此授权缩水。

## 方向变更协议

九类：`scope-expansion` · `constraint-conflict` · `behavior-change` · `architecture-shift` · `data-model-change` · `compatibility-change` · `assumption-invalidated` · `user-direction-change` · `incomplete-delivery`

两个护栏（借自 `dsh-requirements-alignment`）：

- **默认选项兜底**：无论模型提供什么选项，"批准改方向"和"留在当前范围"始终被补上（按标签去重）。防止"留在原范围"的意图被裹进模型改写的标签里、被错记成"修改方向"。
- **答案映射严格化**：自由文本 → `revise`（note 为用户原话）；默认选项 → 按精确标签 `approve`/`reject`；选中的模型选项 → `revise`；**没有选择 / 多选 / 标签对不上 → 抛错，不写任何状态**。静默把决定错记成"拒绝"会污染基线，比报错难查得多。

## 姿态状态机

`unknown` · `aligned` · `drift-pending` · **`baseline-update-pending`**

最后一个是关键：**用户批准了新方向，但新契约还没提交**。这个窗口里会话若被打断，绝不能折成 `aligned`——否则是拿**过期契约**当有效。

## 子 agent

子 agent 没有人类应答者，所以**不能**提交契约、**不能**发起方向变更提问。它应在最终报告里放一个 **"Requirement drift candidate"** 块（原因、当前契约、需要的变更、需要父 agent 替它问什么）。父 agent 拥有用户交互权。

> 这修掉了原先的真窟窿：子 agent 无法设契约，导致预算闸门和 steer 闸门对它**静默失效**。

## 两个必须知道的坑（都真的踩过）

**1. `tool/call` 事件里的 `arguments` 是 JSON 字符串，不是对象。**
`session-format-*` 把 `arguments` 列为字符串字段；解析成对象是 dispatch 层之后的事。折叠日志时**必须自己 `JSON.parse`**。第一版按对象读，于是契约**从来没进过投影**，跨 turn 就消失。症状极具迷惑性：同一个 turn 内一切正常。

**2. 改 `index.js` 之后，`plugin_manager` 的禁用/启用不会重新 import 模块。**
`set_plugin` 只是卸载/重挂那一行，ESM 缓存里的旧模块被复用（实测：改了 schema 后 `cordis_inspect_query` 返回的仍是旧 schema；在 `apply()` 里写标记文件，toggle 后文件不出现）。**改代码后必须重启 DSH 进程**才会生效。

## 配置

见 [`cordis.patch.yml`](cordis.patch.yml)。非法配置在加载时明确抛错，不静默回退。

## 自检与变异验证

```powershell
node check.mjs    # 85 项，无需运行中的 Harness
node teeth.mjs    # 变异验证：把真实回归注入源码，确认测试会变红，然后恢复
```

`check.mjs` 覆盖：配置校验、投影折叠（基线/契约/覆盖/方向变更/姿态/持久化往返）、两道闸门、完整性账本四种判定、答案映射全部路径、默认选项兜底、中英文推迟措辞与假阳性、两个工具的参数与输出 schema 是否落在 registry 强制的 JSON Schema 子集内。

`teeth.mjs` 是本项目的**纪律工具**：注入 5 个真实回归，跑 `check.mjs`，报告几项变红，然后恢复源码。当前结果：

| 注入的回归 | 变红 |
|---|---|
| 新请求保留旧契约（不做重置） | 1 |
| 预算改用全会话步数 | 1 |
| 推迟检测去掉工作动词要求 | 1 |
| 读取非 model 来源的 assistant 记录 | 1 |
| checkpoint 内存改用契约键 | **0（抓不到）** |

**最后一条如实说明**：该 keying 在当前实现下**行为等价**——新请求时契约本就被置 null，代码走"无契约"分支，两种键法结果相同。它在语义上更正确（账本属于请求，不属于契约），但**没有可观测差异可供测试捕获**。我尝试构造区分场景（同一请求内修订契约后再次超支）失败，因为该路径由 `atStep` 守卫主导，不由这个键主导。这不是"以后补测试"能解决的，是等价变换。

## 尚未验证的部分

折叠与闸门只在 `check.mjs` 里用**与真实日志同形状**的事件验证过。真实验证走了一半：第一版在真实会话里被抓出上面那三个 bug，修正后**还没有在真实会话里重新跑过**——需要重启 DSH 并启用插件，然后跑一个故意会缩水的任务。

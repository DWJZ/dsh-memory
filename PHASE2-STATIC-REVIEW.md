# dsh-memory Phase 2 静态审查与修复建议

> 状态：非规范性开发审查记录。本文描述 2026-09-29 工作区中的实现问题和建议修复，不替代 `CONTRACT.md`、README 或源代码。

## 摘要

当前 Phase 2 已具备事件投影、HWM、模型计划、确定性校验、Phase 1 提交复用和 idle debounce 的完整骨架，但仍有五项应优先修复的问题：project-scope `update` 无法提交、失败的 LLM stream 可能被当成成功、secret 检查遗漏截断前原文、缓冲截断不会记录 gap，以及 `/memory disable` 不会停止自动学习。

UTF-8 预算、插件卸载、confidence 持久化和 headless 自动触发也与当前文档承诺不一致。建议先修复写入正确性和安全问题，再调整生命周期与测试结构，最后统一 CONTRACT 和 README。

## 目录

- [审查范围和限制](#审查范围和限制)
- [建议修复顺序](#建议修复顺序)
- [高优先级问题](#高优先级问题)
- [中优先级问题](#中优先级问题)
- [文档修复](#文档修复)
- [建议的最小验收矩阵](#建议的最小验收矩阵)
- [完成标准](#完成标准)

## 审查范围和限制

- 范围：`plugins/dsh-memory` 当前工作区，重点为 `src/consolidation/*`、`src/index.js`、`src/actions.js`、配置、测试和 Phase 2 文档。
- 方法：只做静态代码与接口对照，没有运行测试、构建、lint 或文档 gate。
- 基线限制：`plugins/dsh-memory` 当前整体未被 Git 跟踪，因此无法还原精确的 Phase 1 → Phase 2 diff；本文审查当前完整实现。
- 优先级：高优先级表示可能造成错误写入、安全保证失效、用户控制失效或窗口永久重试；中优先级表示预算、生命周期、兼容性或文档承诺不成立。

## 建议修复顺序

1. 修复 project-scope `update` 参数传递，并覆盖真实提交路径。
2. 严格处理 LLM terminal finish reason。
3. 恢复完整 source text 的 secret 双层扫描。
4. 修复 buffer eviction 的 gap reconciliation。
5. 让 `/memory disable` 停止并收束自动 consolidation。
6. 修复 UTF-8 byte budget 和 quiescent disposal。
7. 明确并持久化 Phase 2 confidence。
8. 决定 headless 是否属于自动 consolidation 的支持范围，并据此修改实现与测试。
9. 统一 CONTRACT、README 和测试说明。

## 高优先级问题

### 1. Project Memory 的自动 `update` 无法提交

位置：`src/consolidation/commit.js` 的 `update` 分支，以及 `src/actions.js` 的 `updateMemory()`。

当前行为：`reviewOperation()` 会为 project-scope target 生成 `operation.projectId`，但 `commit.js` 调用 `updateMemory()` 时没有传入该字段。`updateMemory()` 随后用 `input.projectId` 构造可见 scope；值为 `undefined` 时只搜索 user store，因此 project target 被报告为不可见。

影响：模型提出的合法 project `update` 会进入 `failures`，本次 run 变成 `partial`，HWM 不前进。相同窗口会在后续 idle 周期重新调用模型，直到模型改用其它操作或不再提出该更新。

建议修复：

```js
case 'update':
  return updateMemory(options, {
    id: operation.target_id,
    content: operation.content,
    projectId: operation.projectId,
    evidence: operation.evidence,
    sourceTexts: operation.sourceTexts,
    confidence: operation.confidence,
  })
```

`projectId` 应继续由 validator 从实际 target 继承，不接受模型提供的替代值。

建议回归用例：

- 在 project store 中创建 active target，经 `reviewPlan()` 和 `commitOperations()` 执行 `update`，断言原 id 保留、content 更新、evidence 累积且 run 成功推进 HWM。
- 使用另一个 project 的 id，断言 validator 或可见性检查拒绝，不能跨 project 更新。
- 保留 user-scope update 用例，防止修复 project path 时破坏 user path。

### 2. 非成功的 LLM finish reason 可能提交部分计划

位置：`src/consolidation/model.js` 的 stream 消费循环。

当前行为：代码只记录是否出现过 `type === 'finish'`，没有检查 `chunk.reason.kind`。Harness 的 `LlmRuntime.stream()` 会把 provider throw 归一化为 terminal `error` 或 `aborted` finish，还可能返回 `max-tokens` 或 `tool-calls`。

影响：如果 stream 在失败前已经产生一段可解析的 JSON，当前实现可能解析并提交它，然后推进 HWM。`aborted` 情况尤其可能发生在 agent 或插件正在退出时。

建议修复：保存 terminal reason，并只接受明确允许的成功原因。当前 consolidation 不声明 tools，建议只接受 `stop`；`max-tokens`、`tool-calls`、`error`、`aborted` 和未来未知 reason 均应让本批失败且不移动 HWM。

```js
let finishReason
for await (const chunk of ctx.llm.stream(options)) {
  if (chunk.type === 'text-delta') text += chunk.text
  if (chunk.type === 'finish') finishReason = chunk.reason
}

if (finishReason === undefined) throw new Error('...without a finish reason')
if (finishReason.kind === 'error' || finishReason.kind === 'aborted') {
  throw new Error(`dsh-memory: consolidation ended with ${finishReason.kind}: ${finishReason.failure.code}: ${finishReason.failure.message}`)
}
if (finishReason.kind !== 'stop') {
  throw new Error(`dsh-memory: consolidation ended with ${finishReason.kind}`)
}
```

由于 `FinishReasonMap` 可扩展，默认分支应 fail loud，而不是把未知 reason 当成成功。

建议回归用例：

- 所有 fixture 使用真实的 `{ type: 'finish', reason: { kind: 'stop' } }`。
- 在完整 JSON 后分别发送 `error`、`aborted` 和 `max-tokens` finish，断言 call 失败、store 不变、HWM 不变。
- 覆盖无 finish、空 text 和 stream throw；这些用例与 terminal reason 用例应分开。

### 3. Phase 2 没有扫描截断前的完整 evidence source

位置：`src/consolidation/validate.js` 的 `buildEvidence()`，以及 `src/consolidation/commit.js` 到 Phase 1 actions 的参数传递。

当前行为：`quoteFrom()` 先把 cited event 文本截断，随后 validator 只扫描 `content` 和截断后的 `quote`。Phase 1 actions 已支持 `sourceTexts`，但 consolidation 没有传入。

影响：credential 如果横跨 `evidenceQuoteMaxChars` 截断点，截断后可能只留下不再匹配 detector 的 credential 片段，该片段仍会持久化进 evidence quote。这违反 Phase 1 和 Phase 2 声明的 pre-truncation + pre-persist 双层扫描。

建议修复：

1. `buildEvidence()` 从 cited events 提取完整 text blocks，并在截断前扫描完整文本。
2. reviewed operation 携带仅供内部使用的 `sourceTexts`；该字段不得来自模型、不得进入 audit、dry-run 输出或 canonical record。
3. `commitOperations()` 把 `sourceTexts` 传给 `addMemory()`、`updateMemory()` 和 `supersedeMemory()`，让 Phase 1 action 继续充当最终写入检查点。
4. 保留对最终截断 quote 的第二次扫描。

建议内部数据形式：

```js
{
  ...operation,
  evidence,
  sourceTexts: cited.flatMap(textBlocks),
}
```

建议回归用例：

- credential 完全位于 quote 范围内时拒绝。
- credential 完全位于截断点后时拒绝。
- credential 横跨截断点时拒绝。
- 普通长文本仍可截断并写入。
- dry-run、audit、logger 和 failure message 均不出现完整 source text。

### 4. Buffer eviction 的未观测区间被静默跳过

位置：`src/consolidation/index.js` 的 `reconcile()`。

当前行为：实现先计算 `Math.max(mark, droppedThrough)`，然后在首个保留事件恰好等于 `droppedThrough + 1` 时直接返回旧 mark。这掩盖了 HWM 与 `droppedThrough` 之间被缓冲上限删除的区间。

示例：

```text
stored HWM       = 200
droppedThrough   = 203
first retained   = 204
```

当前条件判断认为 204 与 203 连续，因此不写 gap；后续 run 会消费 204 以后并把 HWM 推过 203，导致 201..203 永久消失且没有审计记录。

建议修复：在 state lock 内以最新 persisted mark 和 `firstSeq` 计算 gap。只要 `firstSeq > currentMark + 1`，就记录 `[currentMark + 1, firstSeq - 1]`。不要用 `droppedThrough` 替换 current mark；它只能帮助解释 collector 为何缺失事件，不能成为“已经消费”的证据。

```js
const written = await withState(stateOptions, current => {
  const currentMark = lastProcessedSeq(current, sessionId)
  if (first <= currentMark + 1) {
    return { changed: false, result: currentMark }
  }
  return {
    changed: true,
    state: recordGap(current, sessionId, {
      from_seq: currentMark + 1,
      to_seq: first - 1,
    }, at),
  }
})
```

在 lock 内重新取 mark 也可以避免另一个进程已经推进 HWM 后，本进程写入过时或重叠的 gap。

建议回归用例：

- 小 buffer 观察超过上限的连续事件，随后 consolidate，断言被 eviction 的范围写入一个 gap。
- persisted mark 位于 eviction 范围中间时，gap 从 `mark + 1` 开始。
- 另一个 writer 已经把 mark 推过 `firstSeq - 1` 时，不追加过时 gap。
- gap 应进入约定的审计计数或字段，而不只写 logger。

### 5. `/memory disable` 不会停止自动 consolidation

位置：`src/index.js` 的 `setEnabled()`、`session/event` listener 和 `agent/status` listener。

当前行为：运行时 `enabled` 只控制 index/tools fiber。事件采集与 idle trigger 只读取启动时的 `settings.consolidation.enabled`，不会检查用户通过 `/memory disable` 修改的状态，也不会取消已有 debounce 或等待在途 run。

影响：命令返回“Memory is disabled”后，插件仍可能收集新轨迹、调用模型、写入 Memory 并推进 HWM。与此同时，手动 `/memory consolidate` 会因为 `isEnabled() === false` 而拒绝，形成相互矛盾的开关语义。

建议修复：让 consolidation controller 暴露异步 `pause()`、`resume()` 和 `dispose()`。

- `pause()` 先阻止新 observe/status work，再取消 pending timers，abort 在途模型调用并等待所有 run settle，最后返回。
- `setEnabled(false)` 必须等待 `pause()` 完成后再向用户报告成功；成功返回后不得再发生该实例发起的 Memory 写入。
- `setEnabled(true)` 恢复未来事件采集和 trigger；禁用期间没有观测到的 seq 在重新启用后按普通 gap 语义处理，不得伪造已消费。
- `consolidation.enabled: false` 继续表示部署级永久关闭；运行时 `enabled` 是额外的用户开关，两者必须同时为 true 才能运行。

建议回归用例：

- pending debounce 后执行 disable，断言 timer 不运行。
- 模型调用在途时执行 disable，断言 signal aborted、disable 等待 run settle、store/HWM 不变。
- disabled 状态下发出 `session/event` 和 `agent/status`，断言不采集、不调模型。
- re-enable 后的新事件可以学习；禁用期间的缺失范围记录为 gap。

## 中优先级问题

### 6. `maxTrajectoryBytesPerBatch` 不是实际 UTF-8 byte ceiling

位置：`src/consolidation/normalize.js` 的 `capEntry()` 和 `batchWindow()`。

当前行为：`value.slice(0, maxBytes)` 按 UTF-16 code units 截取，却把 `maxBytes` 当成 UTF-8 bytes。后缀、JSON wrapper 和同一 entry 的其它 string 字段也不在截断计算中。首个 entry 会无条件加入，即使序列化后仍超过预算。

影响：CJK 或 emoji 轨迹可显著超过配置预算，造成模型上下文溢出、额外费用或 provider 拒绝；tool name 和 arguments 等多个字符串也可共同突破上限。

建议修复：按序列化后的完整 entry 计算剩余预算，并使用不会拆 code point 的 UTF-8 truncation helper。首个超大事件仍可消费，但发送给模型的 `Buffer.byteLength(JSON.stringify(entry), 'utf8')` 必须小于等于允许值；预算太小而连最小 envelope 都放不下时，应发送明确的最小占位 entry，或在配置加载时设定可容纳最小 envelope 的下限。

建议回归用例：1 byte、恰好上限、ASCII、CJK、emoji、多个 string 字段和 oversized 单事件。每个用例都应断言完整 `JSON.stringify(entry)` 的 UTF-8 bytes，而不是只断言 content 变短。

### 7. 插件卸载没有达到 quiescence

位置：`src/consolidation/trigger.js` 的 `dispose()`，以及 `src/index.js` 的 registrations disposer。

当前行为：trigger disposal 只取消 pending timers，不处理 `running` tasks；registrations disposer 使用 `void llmFiber.dispose()`，也不等待 consolidation settle。

影响：HMR、插件卸载或配置重载后，旧实例仍可能完成模型调用、写 Memory、写 audit 或推进 HWM。新旧实例还可能同时工作。

建议修复：用一个 lifecycle controller 统一拥有 pending timers、每个 run 的 AbortController 和 running promises。异步 `dispose()` 应按以下顺序执行：关闭新准入 → 移除 listeners → 取消 timers → abort runs → await all settled → dispose injected fibers。Cordis effect disposer 应返回并 await 这个 promise，不能使用 `void` 丢弃。

建议回归用例：让 model call 卡在 barrier，调用 dispose，断言 disposer 在 barrier/abort settle 前不返回，且 settle 后没有 store、HWM、audit 或 logger 的迟到修改。

### 8. Phase 2 confidence 被丢弃

位置：`src/consolidation/commit.js` 和 `src/actions.js`。

当前行为：validator 保存模型 confidence，但 commit 不传给 actions。`addMemory()` 和 `supersedeMemory()` 永远写 `PHASE1_CONFIDENCE = 1.0`；`updateMemory()` 保留旧 confidence。

影响：dry-run 展示的 confidence 与 canonical record 不一致，所有自动新增或替换的事实看起来都具有显式用户请求的 1.0 置信度。当前检索不使用 confidence，但数据语义已经错误，未来 consumer 会得到误导值。

建议修复：为 Phase 1 action 增加 host-only `confidence` 输入，默认仍为 `1.0`，这样 `memory_remember` 无需也不得暴露该参数；Phase 2 commit 显式传入 reviewed confidence。CONTRACT 需要明确 update 是覆盖为新 proposal confidence，还是采用其它规则。推荐覆盖为新 proposal confidence，因为 content 和 evidence 都在该次 update 中重新判断。

建议回归用例：显式 remember 仍写 1.0；自动 add/supersede/update 分别保留模型值；非法值在 action 层仍被 schema 拒绝。

### 9. Headless 集成没有验证自动触发路径

位置：`test/fixtures/consolidate-on-idle.ts` 和 `test/integration.spec.mjs` 的 automatic consolidation scenario。

当前行为：fixture 明确说明 one-shot harness 会在 debounce 到期前退出，因此测试直接调用 `/memory consolidate`。该场景验证的是手动命令和 pipeline，不是 `agent/status → debounce → maintenance` 自动路径。

影响：默认 headless profile 中自动学习不会发生，但 README 没有声明这一限制；真正的 trigger、shutdown ownership 和 debounce 生命周期也没有 real-composition 证据。

建议修复需要先做产品选择：

- 如果 headless 属于支持范围，让 deferred consolidation 成为 host/agent 生命周期拥有的工作，并让 shutdown 等待它或在最终 idle 执行一次受控 flush。
- 如果只支持长驻 Web/Desktop profile，在 README Known Limitations 和配置说明中明确说明，并把 real automatic integration 放到长驻 app harness。

无论选择哪一种，都应把现有场景重命名为 manual consolidation pipeline integration，并另加一个不调用 `/memory consolidate` 的真实 trigger 场景。

## 文档修复

代码语义确定后，应同步处理以下文档问题：

- `CONTRACT.md` 标题和开头仍把 Automatic Consolidation 列为“不做”，但文件后半又定义 Phase 2。应将当前总契约改为不矛盾的结构，或把 Phase 1/Phase 2 拆成明确的当前规范文件并指定唯一权威。
- README 的存储树应加入 `consolidation-state.json` 及其用途。
- README 应列出 `consolidation` 子字段的逐项默认值和关闭语义，而不是只写“see below”但没有对应说明。
- `autoCommit: false` 当前会消费窗口并推进 HWM，却不保存 accepted plan；应先明确这是不是预期。如果它是观察模式，audit 或用户可读输出必须保留足够结果，否则该配置只会静默丢弃学习机会。
- README 测试数量与 `package.json` 中的 suite 列表不一致；不要手写易漂移的数量，或让一个生成/检查来源拥有它。
- Known Limitations 应根据最终产品选择说明 headless、gap、progress retention 和自动学习开关的实际范围。

## 建议的最小验收矩阵

修复完成后，至少应覆盖以下 acceptance paths。这里列出建议用例，不表示这些命令或测试已经运行。

| 领域 | 必须证明的行为 |
|---|---|
| Project update | project target 可更新；其它 project 不可见；HWM 成功推进 |
| LLM finish | 仅允许的成功 reason 可提交；error/aborted/max-tokens/未知 reason 不写入且不推进 |
| Secret | 完整 source、截断边界和最终 quote 都经过扫描；任何输出不泄漏原文 |
| Gap | late mount、resume、process restart 和 buffer eviction 都产生准确 gap |
| Disable | 成功返回后没有新采集、模型调用、Memory 写入或 HWM 推进 |
| Lifecycle | dispose 取消并等待 pending/running work；无迟到 callback |
| Byte budget | 完整 serialized trajectory entry 在 ASCII/CJK/emoji 下都不超 UTF-8 上限 |
| Confidence | explicit write 为 1.0；automatic add/update/supersede 保留 reviewed 值 |
| Real entry | shipped Loader/profile 经过真实 automatic trigger；manual command 单独验证 |

## 完成标准

- 五个高优先级问题均有实现修复和针对性 regression test。
- 自动 trigger、disable 和 dispose 使用同一个生命周期 owner，所有 teardown 都等待 quiescence。
- Phase 2 的 secret 与 byte guarantees 在最终写入或最终模型输入位置执行，不依赖上游约定。
- CONTRACT、README、实现和测试对 enabled、autoCommit、confidence、gap、headless 支持范围给出同一套当前语义。
- 提交前按照仓库的 `dsh-pre-push-checks` 选择最小相关验证；本文没有执行或声称任何检查通过。

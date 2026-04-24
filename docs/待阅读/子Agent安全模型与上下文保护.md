# 子 Agent 安全模型与上下文保护

> 本文记录了对 cclin 项目子 Agent 系统的安全审计过程：如何发现问题、分析根因、设计改进方案并实施。

## 一、问题发现过程

### 1.1 起点：一个 getter 背后的循环依赖

审查 `index.ts` 中 `spawn_agent` 工具的注册代码时，注意到一个 getter 语法：

```ts
const spawnAgentTool = createSpawnAgentTool({
    get callLLM() {
        if (!subagentCallLLM) throw new Error('callLLM not initialized yet')
        return subagentCallLLM
    },
    executeTool: childExecuteTool,
    systemPrompt,
})
```

这个 getter 存在的原因是**循环依赖**：
- `callLLM` 的创建需要完整的工具列表（`router.toOpenAITools()`）
- 工具列表包含 `spawn_agent` 工具
- `spawn_agent` 工具需要 `callLLM`

解法是 lazy proxy——工具闭包持有对变量的引用，实际执行时变量已被赋值。

### 1.2 深入：子 Agent 的权限模型

沿着 `childExecuteTool` 的构造链路追溯：

```
index.ts:94-97:
const childApprovalManager = new ApprovalManager({ policy: 'session' })
const childOrchestrator = new ToolOrchestrator(router, childApprovalManager)
                                                ^^^^^^
```

发现两个关键问题：

**问题一：工具集完全共享**。子 agent 使用的 `router` 和父 agent 是**同一个实例**，意味着子 agent 可以调用 `write_file`、`edit_file`、`bash` 等所有 mutating 工具，甚至可以调用 `spawn_agent` 递归创建子-子 agent。

**问题二：审批策略名不副实**。注释写着"子 Agent 被父 Agent 信任"，使用了 `session` 策略。但 `createExecuteTool()` 没有传入 `hooks`（审批回调），查看 `orchestrator.ts` 的执行链路：

```ts
// orchestrator.ts:187-189
const decision = hooks?.requestApproval
    ? await hooks.requestApproval(request)
    : 'deny'   // ← 没有 hooks → 直接 deny
```

所以实际效果是：所有 mutating 工具的首次调用会被**静默拒绝**。这与"信任子 Agent"的设计意图完全矛盾。

### 1.3 上下文溢出风险

进一步分析多子 agent 场景。假设父 agent 通过异步模式启动 3 个子 agent：

```
spawn_agent_async → id_A
spawn_agent_async → id_B
spawn_agent_async → id_C
send_input(id_A, "分析 src/")  → 返回 30K 字符
send_input(id_B, "分析 docs/") → 返回 30K 字符
send_input(id_C, "分析 test/") → 返回 30K 字符
wait_agent(id_A) → 30K 作为 tool message 追加到父 history
wait_agent(id_B) → 30K 追加
wait_agent(id_C) → 30K 追加
```

3 个 tool 消息 = 90K 字符 ≈ 22K-30K tokens。加上 system prompt + 已有历史 → 轻松超过 128K 上下文窗口。

**关键发现**：
- 子 agent 创建时**没有传入 `tokenCounter`**，所以自身没有自动压缩能力
- 父 agent 的上下文检测在 `callLLM` **之前**，但工具结果在 `callLLM` **之后**追加
- `SubAgentManager._handles` 是无上限的 Map，没有并发数量限制

## 二、问题汇总

| 编号 | 问题 | 严重程度 | 根因 |
|------|------|----------|------|
| 1 | 子 agent 共享父 agent 完整工具集 | **P0** | `index.ts` 传入同一个 `router` |
| 2 | 审批策略设计意图与实现不一致 | **P0** | `session` 策略 + 无审批回调 = 静默 deny |
| 3 | 子 agent 可递归调用 `spawn_agent` | P2 | 工具集包含 spawn_agent |
| 4 | 异步子 agent 无并发上限 | P1 | `_handles` Map 无 size 检查 |
| 5 | 子 agent 输出无长度保护 | **P1** | `finalText` 直接回灌到父 history |

## 三、改进方案与实施

### 3.1 新增 `auto` 审批策略

**做了什么**：在 `ApprovalPolicy` 联合类型中新增 `'auto'` 值，在 `ApprovalManager.check()` 中增加 `auto` 策略的短路逻辑——直接返回 `{ needsApproval: false }`。

**为什么这么做**：原来用 `session` 策略是想表达"子 Agent 被信任"，但 `session` 策略的语义是"同指纹操作会话内只问一次"，仍然需要首次审批。而 `createExecuteTool()` 没传审批回调，导致首次审批直接 deny。

`auto` 策略的语义明确：**所有调用无条件放行**，不检查 `isMutating`，不走审批流程。这才是"子 Agent 被父 Agent 信任"的正确表达。

```diff
// approval.ts
  check(toolName, input, isMutating): ApprovalCheckResult {
+     if (this._policy === 'auto') {
+         return { needsApproval: false }
+     }
      if (!isMutating) {
          return { needsApproval: false }
      }
```

### 3.2 工具集隔离

**做了什么**：在 `index.ts` 中创建独立的 `childRouter`，只注册只读工具（`read_file`、`list_directory`、`search_files`、`get_memory`、`search_history`）。子 agent 的 orchestrator 使用 `childRouter` 而非父 agent 的 `router`。

**为什么这么做**：最小权限原则。子 agent 的职责是"研究和分析"，不应该有修改文件、执行 shell 命令或递归创建子 agent 的能力。这同时解决了嵌套深度问题——工具集里没有 `spawn_agent`，子 agent 无法递归。

```diff
// index.ts
- const childOrchestrator = new ToolOrchestrator(router, childApprovalManager)
+ const childRouter = new ToolRouter()
+ childRouter.registerNativeTools([
+     readFileTool, listDirectoryTool, searchFilesTool,
+     getMemoryTool, searchHistoryTool,
+ ])
+ const childOrchestrator = new ToolOrchestrator(childRouter, childApprovalManager)
```

> **设计权衡**：如果将来需要子 agent 有写入能力，可以在配置中增加 `subagent.allowed_tools` 白名单，而不是直接共享父 agent 的完整工具集。

### 3.3 输出截断

**做了什么**：
- `spawn-agent.ts`：在 `execute()` 返回前，对 `result.finalText` 做 10K 字符截断
- `subagent-tools.ts`：`wait_agent` 工具的返回结果同样做 10K 截断

**为什么是 10K**：`orchestrator.ts` 的通用截断是 50K，但子 agent 的输出会作为**单个 tool message** 追加到父 history。如果 3 个子 agent 各返回 50K，就是 150K 字符 ≈ 37K tokens，足以撑爆 128K 窗口。10K × 5（最大并发）= 50K 字符 ≈ 12K tokens，安全得多。

```ts
const MAX_RESULT_CHARS = 10_000
const finalText = rawText.length > MAX_RESULT_CHARS
    ? rawText.slice(0, MAX_RESULT_CHARS) +
      `\n...[truncated] Sub-agent output too long (${rawText.length} chars)`
    : rawText
```

### 3.4 并发数量限制

**做了什么**：在 `SubAgentManager.spawn()` 中增加活跃子 agent 数量检查，上限 `MAX_AGENTS = 5`。只统计非 `closed` 状态的句柄。

**为什么这么做**：每个子 agent 都会：
1. 占用一个 64K 上下文窗口的 Session
2. 共享父 agent 的 LLM API Key 和速率限制
3. 输出结果会回灌到父 agent 的上下文

无限制创建会导致内存耗尽、API 配额耗尽和上下文溢出。5 是保守值——`10K × 5 = 50K` 字符的总回灌量对 128K 窗口是安全的。

## 四、上下文溢出的完整防护链

改进后，上下文溢出有 **三道防线**：

```
第一道：并发数量限制（MAX_AGENTS = 5）
  ↓ 限制了同时存在的子 agent 数量
第二道：输出截断（MAX_RESULT_CHARS = 10K）
  ↓ 限制了每个子 agent 回灌到父上下文的数据量
第三道：父 agent 自动压缩（compactThreshold = 80%）
  ↓ 在下一次 callLLM 前触发压缩，释放上下文空间
```

最坏情况下的 token 预算：
- 5 个子 agent × 10K 字符 = 50K 字符 ≈ 12K tokens
- 父 agent 128K 窗口 × 80% 阈值 = 102K tokens 触发压缩
- 12K tokens << 102K tokens → 安全

## 五、改动文件清单

| 文件 | 改动类型 | 改动内容 |
|------|----------|----------|
| `src/types.ts` | 类型扩展 | `ApprovalPolicy` 新增 `'auto'` |
| `src/config/types.ts` | 类型同步 | 同上 |
| `src/tools/approval.ts` | 逻辑新增 | `check()` 增加 `auto` 策略短路 |
| `src/index.ts` | 架构重构 | 创建独立 `childRouter`，审批改为 `auto` |
| `src/tools/spawn-agent.ts` | 安全加固 | 新增 `MAX_RESULT_CHARS` 截断 |
| `src/tools/subagent-tools.ts` | 安全加固 | `wait_agent` 返回值截断 |
| `src/tools/subagent-manager.ts` | 资源限制 | `MAX_AGENTS = 5` 并发上限 |

## 六、验证

- TypeScript 编译：`pnpm run typecheck` ✅
- 全量测试：`pnpm test`（154 tests passed）✅
- 无回归：审批测试（14 tests）+ 编排器测试（10 tests）全部通过


## 对话记录
### 我
既然子agent没有审批，父agent是不是需要限制让子agent的执行任务，还是说项目里是没有设防的


### AI
好问题，让我先看看项目里子 agent 的实际实现。

Viewed spawn-agent.ts:1-166
Viewed index.ts:1-264

让我再看看子 agent 的工具编排器和审批逻辑：

Viewed approval.ts:1-162
Viewed orchestrator.ts:1-322

现在情况很清楚了。回答你的问题：

## 项目当前是**部分设防**，但有明显的安全缺口

### 已有的限制

1. **`maxSteps` 上限**（`spawn-agent.ts:39`）— 子 agent 默认最多跑 10 步，防止无限循环
2. **独立上下文窗口**（`spawn-agent.ts:124`）— 子 agent 用 64K 而非 128K，限制资源占用
3. **`spawn_agent` 本身被标记为 NEVER_PARALLEL**（`orchestrator.ts:48`）— 不会并发启动多个子 agent

### 关键安全缺口：**子 agent 和父 agent 共享同一套完整工具集，但审批全部跳过**

看 `index.ts` 第 94-97 行：

```ts
// 子 Agent 专用工具编排器（审批策略=session 即全部自动批准）
const childApprovalManager = new ApprovalManager({ policy: 'session' })
const childOrchestrator = new ToolOrchestrator(router, childApprovalManager)
const childExecuteTool = childOrchestrator.createExecuteTool()
```

`policy: 'session'` 意味着：**同一指纹的 mutating 操作，第一次自动放行，后续全部缓存放行**。而且由于没有传入 `requestApproval` 回调（`hooks` 是 `undefined`），实际效果是 —— 当 `check.needsApproval === true` 时，代码走到 `orchestrator.ts:187-189`：

```ts
const decision = hooks?.requestApproval
    ? await hooks.requestApproval(request)
    : 'deny'  // 没有 hooks → 直接 deny
```

等等，实际上 `policy: 'session'` 在第一次调用 `check()` 时就会**命中 sessionGrants 缓存**……不对，第一次调用 cache 是空的，会返回 `needsApproval: true`，然后因为没有 `requestApproval` 回调，会被 deny。

**所以真相是：子 agent 用了 `session` 策略但没传审批回调，mutating 工具的第一次调用会被直接 deny。** 这看起来像是个 bug 而不是设计意图——因为注释说"子 Agent 被父 Agent 信任"（`spawn-agent.ts:14`），但实际效果是 `write_file`、`edit_file` 等 mutating 工具**第一次会被无声拒绝**。

### 总结

| 维度 | 当前状态 |
|------|----------|
| 工具集范围 | ❌ 未限制，子 agent 共享父 agent 的**全部**工具（包括 `bash`、`write_file`） |
| 审批机制 | ⚠️ 有 bug：注释说信任子 agent，实际 mutating 工具首次调用被 deny |
| 步数限制 | ✅ 默认 10 步 |
| 上下文限制 | ✅ 64K 较小窗口 |
| 嵌套防护 | ❌ 子 agent 理论上可以再调用 `spawn_agent` 无限嵌套 |

如果要真正做安全，典型做法是给子 agent 一个**受限的只读 ToolRouter**（注释里也提到了 `建议传入受限工具集`），而不是共享父 agent 的完整 router。需要我深入分析或提改进方案吗？

### 我
好的，继续分析，提供改进方案。然后思考一下多个子agent启动后，他们的final text同时发往父agent，它们的上下文超过父agent的上下文长度会发生什么，对子agent的启动数有限制吗

### AI
分析已整理到文档中。总结核心发现：

关键问题
1. 工具没隔离：子 agent 共享父 agent 的全部工具（包括 bash、write_file），但文件注释说"建议传入受限工具集"——是个 TODO 没落实。

2. 审批有 bug：注释说"子 Agent 被父 Agent 信任"，但实际因为没传 requestApproval 回调，所有 mutating 工具首次调用会被静默 deny。设计意图和实现矛盾。

3. 无并发上限：SubAgentManager 的 _handles Map 没有 size 限制，异步模式可以无限创建子 agent。

上下文溢出
你问的核心问题——多个子 agent 的 finalText 同时回灌：

子 agent 自身没有 tokenCounter，不会自动压缩，超窗直接 LLM API 400 报错
父 agent 有自动压缩，但压缩检查在 LLM 调用前，工具结果在 LLM 调用后追加。如果多个 wait_agent 返回值一次性灌入，下一轮才触发压缩
最坏情况：单次工具返回已超剩余容量 → API 400 → Turn 以 error 结束
改进方案按优先级在文档里列了，P0 最紧急的是工具隔离和审批 bug 修复。要不要开始实施？
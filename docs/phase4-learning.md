# Phase 4 学习笔记 — 审批系统与工具编排器

> 这份文档记录了 Phase 4 的每一步做了什么、为什么这样做、思考过程是怎样的。
> 目标：读完后你能**独立从零写出同样的代码**。

---

## 第一部分：宏观理解 — Phase 4 在解决什么问题？

### 1.1 Phase 3 的现状与不足

Phase 3 完成后，我们的工具系统能跑了：

```
用户输入 → LLM → 返回 tool_call → executeTool() → 工具执行 → 结果反馈 LLM
```

但有一个关键问题：**所有工具一律直接执行**。

```typescript
// Phase 3 的执行路径（registry.createExecuteTool）
const tool = this.get(toolName)
const result = await tool.execute(input)  // ← 直接执行，无任何检查
return result.output
```

这意味着：
- `read_file` 读文件？直接执行。
- `write_file` 覆盖文件？直接执行。
- `bash("rm -rf .")` 删目录？直接执行（虽然 safety.ts 会 block 极端命令，但 confirm 级别的会放行）。

> **Phase 4 的核心任务**：在"工具被调用"和"工具被执行"之间，插入一道**权限控制关卡**。

### 1.2 两个组件的设计思路

Phase 4 按 PLAN.md 要求引入两个新组件：

```
Phase 3 的执行路径：
  ReAct 循环 → registry.createExecuteTool() → tool.execute()
                直接执行，没有任何检查 ↑

Phase 4 的执行路径：
  ReAct 循环 → orchestrator.createExecuteTool()
                       ↓
                 ApprovalManager.check()   ← 需要审批吗？
                       ↓
                 requestApproval()         ← 问用户 y/n
                       ↓
                 tool.execute()            ← 执行
                       ↓
                 truncateOutput()          ← 截断过长输出
```

**为什么拆成两个组件，而不是一个？**

因为**审批逻辑**和**执行编排**是两类不同的关注点：

| 组件 | 关注点 | 举例 |
|------|--------|------|
| ApprovalManager | "这个操作需不需要问用户" | 策略缓存、指纹去重 |
| ToolOrchestrator | "怎么执行这个工具" | 查找、解析、执行、截断、错误分类 |

如果合在一起，后续当你想：
- 换 UI（从 readline 换成 Ink TUI）→ 只改审批回调
- 加重试/超时策略 → 只改编排器
- 换审批策略（从 once 换成 session）→ 只改 ApprovalManager

拆开后各改各的，互不影响。

### 1.3 从参考项目（memo-code）学到了什么

开始写代码前，我研究了 memo-code 的实现：

```
memo-code 的审批 + 编排系统（400+ 行）：
├── approval/types.ts     — RiskLevel, ApprovalMode, check/record/grant
├── approval/manager.ts   — createApprovalManager() 工厂
├── approval/classifier.ts — 工具风险分类器  
├── approval/fingerprint.ts — 指纹生成（stableStringify）
├── approval/constants.ts — 默认风险级别映射
├── orchestrator/types.ts  — ToolAction, ToolActionResult, ToolOrchestrator 接口
└── orchestrator/index.ts  — 260+ 行的完整编排实现
```

memo-code 的特点：
1. **三级风险分类**：`read` / `write` / `execute`（每个工具分配风险等级）
2. **三种审批模式**：`auto` / `dangerous` / `strict`（全局模式开关）  
3. **MCP 兼容**：`CallToolResult` 格式、`guardToolResultSize()` 截断
4. **并行执行**：`executionMode: 'parallel'` 支持 `Promise.all()`

**我的简化策略**：

```
memo-code 有的               cclin Phase 4 取舍
─────────────────────────── ─────────────
三级风险（read/write/execute）   ✅ 简化为 isMutating（true/false 二选一）
三种模式（auto/dangerous/strict）  ✅ 简化为 three-policy（always/once/session）
风险分类器（classifier.ts）     ❌ 不做（直接用 ToolDefinition.isMutating）
MCP 兼容格式                   ❌ 不做（Phase 9 的事）
并行执行                        ❌ 不做（顺序执行即可）
指纹生成                        ✅ 保留（stableStringify 思路一样）
结果截断                        ✅ 保留（MAX_OUTPUT_CHARS）
错误分类                        ✅ 简化保留
```

> **原则**：学参考项目的**设计模式**，不照搬它的**复杂度**。
> 当前 5 个工具的规模不需要那么复杂的分类系统。

---

## 第二部分：类型设计 — 先定"形状"再写代码

> 对应源码：[types.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/types.ts) 末尾新增的 Phase 4 类型

### 2.1 思考起点："先想清楚数据流，再写类型"

Phase 4 的数据流有三个关键节点：

```
节点 1：审批检查  "这个工具需要问用户吗？"  → ApprovalCheckResult
节点 2：用户决定  "用户说 yes 还是 no？"    → ApprovalDecision
节点 3：执行结果  "工具跑完了，结果是什么？"  → ToolActionResult
```

每个节点对应一组类型。我按数据流的顺序设计它们。

### 2.2 `ApprovalPolicy` — 三种策略怎么来的？

```typescript
export type ApprovalPolicy = 'always' | 'once' | 'session'
```

**思考过程**：想象你是用户，面对不同场景：

- **调试阶段**：Agent 频繁写文件、跑命令。每次都问太烦了
  → `once`：同样的操作只问一次
- **生产环境**：每个操作都要确认，安全第一
  → `always`：每次都问
- **信任模式**：整个会话只确认一次，后续同类操作自动放行
  → `session`

### 2.3 `ApprovalCheckResult` — 联合类型的设计技巧

```typescript
export type ApprovalCheckResult =
    | { needsApproval: false }
    | { needsApproval: true; fingerprint: string; reason: string; ... }
```

**为什么用联合类型（discriminated union）而不是可选字段？**

```typescript
// 方案 B：可选字段（不推荐）
type Result = { needsApproval: boolean; fingerprint?: string }

if (!result.needsApproval) {
    console.log(result.fingerprint)  // ← 编译通过，但运行时 undefined！
}
```

联合类型让 TypeScript **自动收窄**：

```typescript
if (result.needsApproval) {
    console.log(result.fingerprint)  // ← TS 保证此处一定有值
}
```

> **原则**：用联合类型代替可选字段，让编译器帮你检查"不该出现的组合"。

### 2.4 `ToolAction` — 为什么需要标准化请求对象？

Phase 3 的执行只有一步（直接调用），用 `toolName + toolInput` 参数就够了。
但 Phase 4 的路径有多步（审批 → 执行），需要**一个对象贯穿流程**，
并且带上 `id` 便于关联请求和结果。

```typescript
export type ToolAction = { id: string; name: string; input: unknown }
export type ToolActionResult = {
    actionId: string        // 关联到 ToolAction.id
    status: ToolActionStatus  // 成功/拒绝/找不到/输入错误/失败
    observation: string     // 返回给 LLM 的文本
    durationMs: number      // 执行耗时（可观测性）
}
```

---

## 第三部分：ApprovalManager — 审批的核心逻辑

> 对应源码：[approval.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/tools/approval.ts)

### 3.1 思考起点："怎么判断一个工具需不需要审批？"

最简单的做法是写一个黑名单：

```typescript
// 方案 A：硬编码名单（不可扩展）
const NEEDS_APPROVAL = ['bash', 'write_file', 'edit_file']
if (NEEDS_APPROVAL.includes(toolName)) { ... }
```

但这有两个问题：
1. 每加一个工具就要改这个名单
2. 自定义工具（Phase 9 MCP）怎么办？

**更好的做法**：利用 Phase 3 已有的 `ToolDefinition.isMutating` 字段。

```typescript
// 方案 B：基于工具自身属性（可扩展）
if (isMutating) { ... }  // 每个工具注册时就声明了自己是否 mutating
```

这样任何新工具只需要在定义时设 `isMutating: true`，审批系统自动生效。

### 3.2 指纹（Fingerprint）是怎么回事？

**问题**：用户批准了 `write_file({ path: "hello.txt", content: "hi" })`，
下次同样的调用还要问吗？

如果策略是 `once`，答案是"不用"。但怎么判断"同样的调用"？

```typescript
// 指纹 = 工具名 + 输入参数的稳定序列化
function generateFingerprint(toolName: string, input: unknown): string {
    return `${toolName}::${stableStringify(input)}`
}
```

**为什么需要 `stableStringify`？**

普通 `JSON.stringify` 的输出和 key 的顺序有关：
```javascript
JSON.stringify({b: 1, a: 2})  // '{"b":1,"a":2}'
JSON.stringify({a: 2, b: 1})  // '{"a":2,"b":1}'  ← 不同！
```

同样的参数，key 顺序不同就产生不同指纹。所以先排序再序列化：

```typescript
function stableStringify(value: unknown): string {
    const sorted = Object.keys(value).sort().reduce(...)
    return JSON.stringify(sorted)
}
```

### 3.3 三种策略的实现差异

```typescript
recordDecision(fingerprint: string, decision: ApprovalDecision): void {
    if (decision !== 'approve') return

    if (this.policy === 'once') {
        this.onceGrants.add(fingerprint)     // Turn 结束时清除
    } else if (this.policy === 'session') {
        this.sessionGrants.add(fingerprint)  // Session 结束时清除
    }
    // always 策略不缓存 → 每次都问
}
```

两个 `Set` 的生命周期不同：

| Set | 写入时机 | 清除时机 | 效果 |
|-----|---------|---------|------|
| `onceGrants` | `policy === 'once'` 且用户批准 | `clearOnceApprovals()`（Turn 结束） | 本轮审批免问 |
| `sessionGrants` | `policy === 'session'` 且用户批准 | `dispose()`（Session 结束） | 整个会话免问 |

> **落地细节**：为了让 `clearOnceApprovals()` 真正能在 Turn 结束时被调用，我们在 `SessionOptions` 和 `RunTurnDeps` 中注入了 `clearApprovalsFn` 回调，并在 `react-loop.ts` 的最后主动调用它（解决"本轮一次"变"全局一次"的 Bug）。

> **设计洞察**：两个 Set 的关系不是"或"，而是"层级"。
> 检查时 `isGranted()` 查两个 Set，只要任一包含就放行。
> 这样 `session` 策略的授权在 `clearOnceApprovals()` 后仍有效。

---

## 第四部分：ToolOrchestrator — 执行的统一入口

> 对应源码：[orchestrator.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/tools/orchestrator.ts)

### 4.1 思考起点："Phase 3 的 createExecuteTool 有什么不足？"

Phase 3 的 `ToolRegistry.createExecuteTool()` 做了三件事：
1. 查找工具
2. 解析输入
3. 执行并返回结果

Phase 4 需要在中间插入更多步骤，但不想污染 Registry（它的职责只是存储和查询）。

所以创建一个新类 `ToolOrchestrator`，把 Registry 的 `createExecuteTool` 替代掉，
同时承载所有新增的职责。

### 4.2 executeAction 的六步流水线

```typescript
async executeAction(action: ToolAction, hooks?: ApprovalHooks) {
    // 1. 工具查找 — 工具存在吗？
    const tool = this.registry.get(action.name)
    if (!tool) return { status: 'tool_not_found', ... }

    // 2. 审批检查 — 需要用户确认吗？
    const check = this.approvalManager.check(name, input, tool.isMutating)
    if (check.needsApproval) {
        const decision = await hooks?.requestApproval?.(request)
        if (decision === 'deny') return { status: 'approval_denied', ... }
    }

    // 3. 输入解析 — unknown → Record<string, unknown>
    const parsedInput = parseToolInput(action.input)

    // 4. 执行工具
    const result = await tool.execute(parsedInput)

    // 5. 错误分类 — 区分权限错误 vs 一般错误
    // （通过 result.isError 和 catch 判断）

    // 6. 结果截断 — 防止超长输出撑爆上下文
    const output = truncateOutput(result.output, action.name)

    return { status: 'success', observation: output, ... }
}
```

**为什么每一步都返回 `ToolActionResult` 而不抛异常？**

因为工具执行的"失败"不是程序错误，而是**正常的业务结果**：
- 工具不存在 → 告诉 LLM "没有这个工具"
- 用户拒绝 → 告诉 LLM "用户不允许"
- 执行出错 → 告诉 LLM "命令失败了"

这些都是 LLM 需要看到的 observation，不应该用异常中断循环。

### 4.3 createExecuteTool — 适配器模式

```typescript
createExecuteTool(hooks?: ApprovalHooks): ExecuteTool {
    return async (toolName, toolInput) => {
        const action: ToolAction = {
            id: `${toolName}:${Date.now()}`,
            name: toolName,
            input: toolInput,
        }
        const result = await this.executeAction(action, hooks)
        return result.observation  // ToolActionResult → string
    }
}
```

**这里的关键洞察**：ReAct 循环的 `ExecuteTool` 接口（Phase 2 定义的）只接受
`(string, unknown) => Promise<string>`。Orchestrator 内部用更丰富的
`ToolAction → ToolActionResult`，但对外暴露时**降级**为简单接口。

```
内部丰富接口：ToolAction → executeAction() → ToolActionResult（含 status, durationMs, ...）
外部简单接口：(name, input) → createExecuteTool() → string（只留 observation）
```

这就是**适配器模式**：在不改变消费方接口的前提下，增强内部实现。
Phase 2 的循环代码**一行都不用改**。

### 4.4 辅助函数：truncateOutput

```typescript
function truncateOutput(output: string, toolName: string): string {
    if (output.length <= MAX_OUTPUT_CHARS) return output
    return output.slice(0, MAX_OUTPUT_CHARS) +
        `\n...[truncated] ${toolName} output too long`
}
```

**为什么需要截断？**

Agent 读一个 10 万行的日志文件，`read_file` 返回几 MB 文本。
如果全部塞进对话历史，会：
1. 占满上下文窗口（Phase 6 压缩前尤其严重）
2. 增加 API 费用
3. LLM 可能忽略重要信息（"迷失在中间"问题）

截断后告诉 LLM "输出太长了"，它会学会用 `offset/limit` 分段读取。

---

## 第五部分：集成 — 如何"最小侵入"地接入

> 对应源码：[index.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/index.ts)

### 5.1 思考起点："改得越少越好"

Phase 4 新增了 ApprovalManager 和 ToolOrchestrator，但 **ReAct 循环和 Session 一行都不用改**。

为什么？因为 Phase 2 定义的 `ExecuteTool` 接口足够抽象：

```typescript
type ExecuteTool = (toolName: string, toolInput: unknown) => Promise<string>
```

Phase 3 由 `registry.createExecuteTool()` 实现这个接口。
Phase 4 由 `orchestrator.createExecuteTool()` 实现同一个接口。
**消费方（循环/Session）看到的接口没有变。**

### 5.2 index.ts 的变化（diff 视角）

```diff
 // 这两行不变
 const registry = new ToolRegistry()
 registry.registerMany([readFileTool, writeFileTool, ...])
 const callLLM = createCallLLM({ apiKey, baseURL, model, tools: registry.toOpenAITools() })

+// 新增：创建审批管理器和编排器
+const approvalManager = new ApprovalManager({ policy: 'once' })
+const orchestrator = new ToolOrchestrator(registry, approvalManager)

 const session = new Session({
     callLLM,
     systemPrompt: '...',
-    executeTool: registry.createExecuteTool(),          // ← Phase 3
+    executeTool: orchestrator.createExecuteTool({       // ← Phase 4
+        requestApproval: createReadlineApproval(),
+    }),
 })
```

**变化总结**：
1. 新增两个实例（approvalManager, orchestrator）
2. 把 `registry.createExecuteTool()` 换成 `orchestrator.createExecuteTool(hooks)`
3. 传入 `createReadlineApproval()` 作为审批回调

### 5.3 审批回调的实现 — readline 版本

```typescript
function createReadlineApproval() {
    return (request: ApprovalRequest): Promise<ApprovalDecision> => {
        return new Promise((resolve) => {
            console.log(`\n  🔐 审批请求: ${request.toolName}`)
            console.log(`     ${request.reason}`)
            rl.question('     允许执行? (y/n): ', (answer) => {
                resolve(answer.trim().toLowerCase() === 'y' ? 'approve' : 'deny')
            })
        })
    }
}
```

**为什么返回一个函数（而不是直接传一个方法）？**

因为 `ApprovalHooks.requestApproval` 的签名是：
```typescript
(request: ApprovalRequest) => Promise<ApprovalDecision>
```

`createReadlineApproval()` 是一个**工厂函数**，它可以：
- 闭包捕获 `rl`（readline 接口实例）
- 未来轻松替换为 Ink TUI 版本（Phase 8）

```
Phase 4: createReadlineApproval() → readline.question() → y/n
Phase 8: createInkApproval()      → <ApprovalOverlay /> → 按钮点击
```

UI 变了，但 Orchestrator 的代码不用改——因为它只认 `ApprovalHooks` 接口。

---

## 第六部分：总结 — 你应该记住的核心概念

### 设计原则

| 原则 | 在 Phase 4 中的体现 |
|------|---------------------|
| **关注点分离** | ApprovalManager 管策略，Orchestrator 管执行，互不干涉 |
| **适配器模式** | `createExecuteTool()` 把丰富的 `ToolActionResult` 降级为 `string` |
| **回调解耦** | UI 通过 `ApprovalHooks` 注入审批逻辑，Orchestrator 不知道 UI |
| **联合类型** | `ApprovalCheckResult` 用 discriminated union 保证类型安全 |
| **指纹去重** | `stableStringify` 保证相同操作产生相同指纹 |
| **最小侵入** | ReAct 循环和 Session **零改动**，只改了 index.ts 的组装方式 |

### Phase 4 新增文件总结

```
types.ts          +65 行: ApprovalPolicy, ApprovalCheckResult, ToolAction, ToolActionResult...
tools/approval.ts  新文件: ApprovalManager 类（check/record/grant/clear/dispose）
tools/orchestrator.ts  新文件: ToolOrchestrator 类（6步流水线 + createExecuteTool 适配器）
index.ts           修改: 组装 ApprovalManager → Orchestrator → Session
```

### 完整数据流（带审批）

```
用户键入 "帮我创建一个 hello.txt"
    ↓
index.ts: session.runTurn("帮我创建一个 hello.txt")
    ↓
react-loop.ts: callLLM(history) → LLM 返回 tool_call: write_file({path:"hello.txt"})
    ↓
react-loop.ts: executeTool("write_file", {path:"hello.txt"})
    ↓                          ← 这里内部走的是 orchestrator.createExecuteTool()
orchestrator.ts: executeAction({name:"write_file", input:{...}})
    ↓
    ├── 1. registry.get("write_file") → 找到工具定义
    ├── 2. approvalManager.check("write_file", input, true)
    │       → isMutating=true → needsApproval=true
    ├── 3. hooks.requestApproval({toolName:"write_file", reason:"..."})
    │       → 终端显示 "🔐 审批请求: write_file"
    │       → 用户输入 "y"
    │       → approvalManager.recordDecision(fingerprint, 'approve')
    ├── 4. tool.execute({path:"hello.txt", content:""})
    ├── 5. truncateOutput(result.output)
    └── 6. return { status:'success', observation:'File written.' }
    ↓
react-loop.ts: observation = "File written."
    ↓
react-loop.ts: history.push({role:'tool', content: observation})
    ↓
react-loop.ts: callLLM(history) → LLM: "文件已创建。"
    ↓
index.ts: console.log("文件已创建。")
```

### 后续 Phase 会怎么扩展？

- **Phase 7（Hook）**：Orchestrator 的审批回调会升级为 Hook 事件
  (`onApprovalRequest` / `onApprovalResponse`)
- **Phase 8（TUI）**：`createReadlineApproval()` 替换为 Ink 组件
- **Phase 9（MCP）**：Orchestrator 将同时路由 native 和 MCP 工具

每个 Phase 都是在现有架构上**插入**，而不是推翻重来。
这正是 Phase 2 定义接口、Phase 3 定义工具、Phase 4 定义编排所建立的**稳定骨架**的回报。

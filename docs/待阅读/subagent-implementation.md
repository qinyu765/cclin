# Subagent 实现学习文档

> 记录为 cclin 项目新增 Subagent 功能的完整过程：做了什么、为什么这样设计、每行代码背后的思路。

---

## 一、做了什么（变更清单）

新增 4 个文件，修改 2 个文件：

| 文件 | 操作 | 作用 |
|------|------|------|
| `src/types.ts` | 修改 | 追加 6 个 Subagent 相关类型 |
| `src/tools/spawn-agent.ts` | 新增 | **方案一**：同进程阻塞式 `spawn_agent` 工具 |
| `src/tools/subagent-manager.ts` | 新增 | **方案二核心**：`SubAgentManager` 异步注册表 |
| `src/tools/subagent-tools.ts` | 新增 | **方案二工具集**：4 个 LLM 可调用工具 |
| `src/index.ts` | 修改 | 注册工具 + 破解循环依赖 |

**新增工具列表**（LLM 现在可以调用这些）：

| 工具名 | 方案 | 语义 |
|--------|------|------|
| `spawn_agent` | 方案一 | 创建子 Agent 并一次性执行到完成，阻塞返回结果 |
| `spawn_agent_async` | 方案二 | 创建子 Agent 并立即返回 `agent_id` |
| `send_input` | 方案二 | 向子 Agent 发送消息，非阻塞开始执行 |
| `wait_agent` | 方案二 | 等待子 Agent 完成，返回结果（阻塞） |
| `close_agent` | 方案二 | 关闭子 Agent，释放资源 |

---

## 二、背景：Subagent 是什么

cclin 的父 Agent 通过 ReAct 循环执行任务：**思考 → 调用工具 → 观察结果 → 继续思考**。

Subagent 的本质是：把某次"调用工具"替换为"启动另一个完整的 Agent"。

```
父 Agent ReAct 循环
  │
  ├─ 调用 read_file    → 直接执行，返回文件内容
  ├─ 调用 bash         → 直接执行，返回命令输出
  └─ 调用 spawn_agent  → 启动子 Agent（独立 Session）
                           子 Agent 自己的 ReAct 循环
                           ├─ 调用 read_file
                           ├─ 调用 search_files
                           └─ 输出最终答案
                         ↩ 子 Agent 输出作为工具结果返回父 Agent
```

**为什么要子 Agent？**

- 复杂任务分解：让子 Agent 专注一个子任务，独立维护上下文
- 并行执行：同时运行多个子 Agent，各自分析不同模块
- 上下文隔离：子 Agent 的错误不污染父 Agent 的历史

---

## 三、方案一：同进程阻塞式

### 核心思想

把子 Agent 封装成"一个工具调用"。父 Agent 调用 `spawn_agent`，内部 `new Session()` 然后 `await runTurn(task)`，完成后把 `finalText` 作为工具输出返回，父 Agent 继续。

```
父 ReAct  →  executeTool("spawn_agent")
                │
                │  【阻塞，父 Agent 等待】
                ▼
              new Session()  →  runTurn(task)
                                  子 ReAct 循环...
                                  最终 finalText
                │
                └─ 返回 finalText 作为 observation
父 ReAct  ←  继续下一步
```

### 核心代码：`src/tools/spawn-agent.ts`

**工厂函数**（依赖注入，不依赖全局状态）：

```typescript
export function createSpawnAgentTool(deps: SpawnAgentDeps): ToolDefinition {
    const { callLLM, executeTool, systemPrompt, defaultMaxSteps = 10 } = deps

    return {
        name: 'spawn_agent',
        isMutating: false,

        async execute(input) {
            const task = input['task'] as string
            const context = input['context'] as string | undefined

            // 拼接上下文（如有）
            const agentInput = context
                ? `Context:\n${context}\n\nTask:\n${task}`
                : task

            // 创建独立的子 Session
            const childSession = new Session({
                sessionId: randomUUID(),
                callLLM,
                executeTool,
                systemPrompt,
                contextWindow: 64_000,   // 比父 Agent 小，防止嵌套爆窗
                compactThreshold: 75,
                // 注意：没有 hooks，子 Agent 不驱动 TUI
            })

            // 阻塞执行
            const result = await childSession.runTurn(agentInput)

            return {
                output: `[Sub-agent ${shortId}] Completed in ${stepCount} step(s).\n\n${result.finalText}`
            }
        }
    }
}
```

**关键设计决策**：

| 决策 | 原因 |
|------|------|
| `contextWindow: 64_000`（父 Agent 是 128K）| 嵌套执行，子 Agent 上下文要更保守 |
| 不传 `hooks` | 子 Agent 没有 TUI，Hook 回调会找不到目标 |
| 子 Agent 用 `childExecuteTool`（自动审批）| 不能让子 Agent 弹出 TUI 的审批对话框 |
| 接受 `context` 参数 | 父 Agent 可以把关键背景信息传递给子 Agent |

---

## 四、方案二：异步注册表式

### 核心思想

把子 Agent 的**创建**和**执行**分离，父 Agent 可以先 spawn 多个，并行 send_input，最后用 wait 收集结果。

```
父 Agent:  spawn_agent_async  → id_A
父 Agent:  spawn_agent_async  → id_B
父 Agent:  send_input id_A "分析 A 模块"   ← 返回 "Running..."，非阻塞
父 Agent:  send_input id_B "分析 B 模块"   ← 返回 "Running..."，非阻塞
           （此时 A 和 B 的 runTurn 在 JS 事件循环中并发执行）
父 Agent:  wait_agent id_A  → 等待 A 完成，获取结果
父 Agent:  wait_agent id_B  → 等待 B 完成，获取结果
父 Agent:  close_agent id_A
父 Agent:  close_agent id_B
```

### 数据结构：`SubAgentHandle`

`SubAgentManager` 内部维护一个 `Map<agentId, InternalHandle>`：

```typescript
// 内部句柄（比公开类型多一个 Promise 字段）
type InternalHandle = {
    id: string
    session: Session                          // 子 Session 实例
    status: SubAgentStatus                    // 当前状态
    runningPromise: Promise<TurnResult> | null // ← 核心字段
    lastResult: string | undefined            // 上次结果缓存
    createdAt: string
}
```

### 状态机

```
    spawn()
       │
       ▼
    [idle]  ─────────────── 刚创建，没有任务
       │  sendInput()
       ▼
   [running]  ──────────── runningPromise 正在执行
       │
       │ Promise 完成（在 .then() 回调里自动更新）
       ▼
[idle_after_turn]  ──────── lastResult 已缓存
       │                         │
    sendInput()               close()
       │                         │
       ▼                         ▼
   [running]                 [closed]
```

### 最关键的代码：`sendInput()` 非阻塞

这是方案二的精髓，理解这段就理解了整个异步模型：

```typescript
sendInput(agentId: string, message: string): void {
    const handle = this._requireHandle(agentId)

    handle.status = 'running'

    // ① 启动执行，但"故意"不 await
    //    Promise 一旦创建就开始在 JS 事件循环里执行
    handle.runningPromise = handle.session.runTurn(message)

    // ② 挂载回调，子 Agent 完成后在后台自动更新状态
    //    注意：这个 .then() 不会阻塞当前函数
    handle.runningPromise.then((result) => {
        handle.lastResult = result.finalText
        handle.status = 'idle_after_turn'
    }).catch(() => {
        handle.status = 'idle_after_turn'
    })

    // ③ 立即返回（sendInput 是同步函数！）
}
```

**为什么不 await？**

JavaScript 的 Promise 一旦创建（`session.runTurn(message)` 被调用）就开始执行，
`await` 只是"等它完成再继续当前函数"。不 await 的话：

- `sendInput()` 立即返回，父 Agent 可以继续调用其他工具（比如再 `send_input` 给另一个子 Agent）
- `runTurn()` 在事件循环里继续跑，不被阻断
- 多个子 Agent 的 `runTurn` Promise **真正并发执行**

### `wait()` 的实现

```typescript
async wait(agentId: string): Promise<string> {
    const handle = this._requireHandle(agentId)

    if (handle.runningPromise) {
        // 真正等待 Promise 完成（此时才阻塞）
        const result = await handle.runningPromise
        handle.runningPromise = null   // 清空，防止二次 await 混乱
        handle.lastResult = result.finalText
        handle.status = 'idle_after_turn'
        return result.finalText
    }

    // Promise 已完成，直接返回缓存（幂等）
    if (handle.lastResult !== undefined) {
        return handle.lastResult
    }

    throw new Error('No running task. Call send_input() first.')
}
```

**注意**：同一个 Promise 可以被 `await` 多次，每次都返回相同结果（Promise 幂等性），所以重复调用 `wait_agent` 是安全的。

---

## 五、破解循环依赖（index.ts 的技巧）

### 问题

注册 Subagent 工具时遇到了一个循环依赖：

```
callLLM 需要 router.toOpenAITools()（包含 subagent 工具）
                    ↕ 循环！
subagent 工具需要 callLLM
```

如果先创建 `callLLM`，subagent 工具不在工具列表里，LLM 不知道能调用它们。
如果先注册 subagent 工具，工具里的 `callLLM` 字段还没有值。

### 解决方案：Lazy 代理（变量引用延迟求值）

```typescript
// ① 先声明一个"占位变量"
let subagentCallLLM: CallLLM | null = null

// ② 注册工具时，闭包"引用"这个变量（而非变量当前的值）
const spawnAgentTool = createSpawnAgentTool({
    get callLLM() {
        // 属性 getter：每次读取时才求值
        if (!subagentCallLLM) throw new Error('not initialized')
        return subagentCallLLM
    },
    executeTool: childExecuteTool,
    systemPrompt,
})

const subAgentManager = new SubAgentManager(
    // 箭头函数：执行时才读取 subagentCallLLM
    (messages, onChunk) => {
        if (!subagentCallLLM) throw new Error('not initialized')
        return subagentCallLLM(messages, onChunk)
    },
    childExecuteTool,
    systemPrompt,
)

// ③ 向 router 注册所有工具（此时 callLLM 还是 null，但工具已在列表里）
router.registerNativeTools([spawnAgentTool, ...asyncSubAgentTools])

// ④ 现在 router 工具列表完整，创建 callLLM
const callLLM = provider.createCallLLM({
    tools: router.toOpenAITools(), // ← 此时 subagent 工具已在列表里
})

// ⑤ 填充变量（之后工具执行时 getter/闭包 读到正确值）
subagentCallLLM = callLLM
```

**原理**：

> JS 的 getter 和箭头函数**捕获的是变量本身**（引用），而不是变量当时的值。所以在 `subagentCallLLM = callLLM` 执行后，所有之前定义的 getter 和闭包都能读取到正确的 `callLLM`。

这是**延迟求值（lazy evaluation）**的经典模式，也叫"前向引用"。

---

## 六、方案对比

| 维度 | 方案一（阻塞式）| 方案二（异步式）|
|------|------------|------------|
| **接口复杂度** | 1 个工具 | 4 个工具 |
| **并行能力** | ❌ 串行阻塞 | ✅ 多个子 Agent 并发 |
| **父 Agent 感知** | 工具调用即完成 | 需要管理 agent_id |
| **TUI 展示** | 普通工具调用折叠 | 可展示多 Agent 活动 |
| **实现复杂度** | 低（~100 行）| 中（~300 行）|
| **适用场景** | 简单子任务委托 | 多任务并行 / 交互式子 Agent |
| **代码可读性** | 高 | 中 |

### 什么时候用方案一

- 子任务明确、一次性（"帮我分析这个文件的结构"）
- 不需要并行
- 重视简洁性

### 什么时候用方案二

- 需要并行处理多个子任务（"同时分析 A、B、C 三个模块"）
- 子任务需要多轮交互（spawn → 发送初始任务 → 收到结果 → 发送追问 → wait 最终答案）
- 未来想增加取消、暂停等控制语义

---

## 七、新增类型速览（`src/types.ts`）

```typescript
// 子 Agent 运行状态
type SubAgentStatus = 'idle' | 'running' | 'idle_after_turn' | 'closed'

// spawn_agent / spawn_agent_async 工具的输入参数
type SpawnAgentInput = {
    task: string        // 任务描述（必填）
    context?: string    // 额外上下文（选填）
    max_steps?: number  // 最大步骤数（默认 10）
}

// send_input 工具的输入参数
type SendInputArgs = {
    agent_id: string
    message: string
}

// wait_agent / close_agent 工具的输入参数
type AgentIdArgs = {
    agent_id: string
}

// 方案二的"子 Agent 句柄"（对外暴露的快照）
type SubAgentHandle = {
    id: string
    status: SubAgentStatus
    lastResult?: string
    createdAt: string
}
```

---

## 八、学习要点总结

1. **工具即接口**：LLM 通过工具调用驱动系统行为，Subagent 只是在工具内部又启动一个 `Session`，不需要修改 ReAct 循环本身。

2. **依赖注入**：工具工厂函数（`createSpawnAgentTool`）通过参数接收 `callLLM`、`executeTool` 等依赖，而不是直接 import 全局变量。这让工具可测试、可复用。

3. **Promise 不 await = 非阻塞**：JS Promise 创建即执行，`await` 只是"等待当前函数"。不 await 就不阻塞，这是方案二并发的基础。

4. **Lazy 代理破解循环依赖**：通过 getter 或闭包引用变量（而非变量值），可以在变量赋值前就"注册"对它的访问，在真正执行时再求值。这是 JS 中处理初始化顺序问题的常见技巧。

5. **子 Agent 审批策略 = session**：`ApprovalManager({ policy: 'session' })` 意味着同一类操作只问一次（第一次自动批准后整个 session 有效），配合子 Agent 就相当于"全部自动批准"，不会弹出 TUI 审批框。

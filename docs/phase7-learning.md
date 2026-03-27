# Phase 7 学习笔记 — Hook / 中间件系统

> 这份文档记录了 Phase 7 的每一步做了什么、为什么这样做、思考过程是怎样的。
> 目标：读完后你能**独立从零写出同样的代码**。

---

## 第一部分：宏观理解 — Phase 7 在解决什么问题？

### 1.1 Phase 6 的现状与不足

Phase 6 完成后，cclin 有了完整的上下文压缩能力。但代码中充斥着硬编码的 `console.log`：

```typescript
// react-loop.ts 中，工具调用时：
console.log(`  🔧 [step ${step}] calling tool: ${block.name}`)

// session.ts 中，Turn 开始时：
console.log(`\n── Turn ${this.turnIndex} ──`)

// react-loop.ts 中，token 检测时：
console.log(`  ⚠️ Context usage: ${currentTokens}/${contextWindow} tokens ...`)
```

**问题在哪？** 这些 `console.log` 把"做什么"和"怎么展示"绑在了一起。想象以下场景：

| 场景 | 需要做的 | 当前的问题 |
|------|---------|-----------|
| Phase 8 做 TUI 界面 | 把文字输出改为 Ink 组件渲染 | 需要**删掉** console.log，改成组件调用 |
| 加日志文件记录 | 把事件写入 JSONL 文件 | 需要在同样的位置再加一行 `fs.write(...)` |
| 做单元测试 | 测试 ReAct 循环逻辑 | console.log 会污染测试输出 |

每增加一种"展示方式"，就要回去修改 `react-loop.ts` 和 `session.ts`——这违反了**开放-封闭原则**（对扩展开放，对修改封闭）。

> **Phase 7 的核心任务**：把 ReAct 循环中的"关键时刻"变成**可订阅的事件**。谁关心这个事件，谁就注册一个 handler，核心代码不用动。

### 1.2 什么是 Hook？用生活类比

Hook 就像**广播系统**：

```
                    ┌─────────────── 广播塔（ReAct 循环）──────────────┐
                    │                                                 │
                    │  工具调用开始了！                                │
                    │         ↓ 广播信号                              │
                    │                                                 │
                    └─────────────────────────────────────────────────┘
                              │           │            │
                              ↓           ↓            ↓
                     📻 日志打印    📻 UI 更新     📻 文件记录
                     （听众 A）    （听众 B）     （听众 C）
```

- **广播塔**不关心有多少听众，也不关心听众做什么
- **听众**各自处理收到的信号——打印日志、更新 UI、写文件...
- 新增听众**不需要改广播塔的代码**

### 1.3 从参考项目（memo-code）学到了什么

开始写代码前，我研究了 memo-code 的 Hook 系统：

```
memo-code 的 Hook 系统：
├── types.ts                — 9 种 Hook Payload 类型 + AgentHooks + AgentMiddleware
└── runtime/hooks.ts        — Hook 引擎
    ├── HookName             — 9 种 hook 名称的联合类型
    ├── HookPayloadMap       — hook名 → payload类型 的映射
    ├── HookRunnerMap        — hook名 → handler数组[] 的注册表
    ├── emptyHookMap()       — 创建空注册表
    ├── registerMiddleware() — 注册单个中间件
    ├── buildHookRunners()   — 从配置构建完整注册表
    ├── runHook()            — 安全执行（try/catch 隔离）
    └── snapshotHistory()    — 深拷贝历史（防止 hook 修改共享状态）
```

**memo-code 和 cclin 的差异决策**：

| memo-code 的做法 | cclin Phase 7 取舍 |
|---|---|
| `AgentSessionDeps` 包含 hooks + middlewares | ✅ 保留，但放在 `SessionOptions` 中（更简洁） |
| `buildHookRunners(deps)` 接收整个 deps | ✅ 简化为 `buildHookRunners(hooks?, middlewares?)`（只传需要的） |
| Hook 在 session_runtime.ts 中发射 | ✅ 改为在 `react-loop.ts` 和 `session.ts` 中分别发射 |
| `snapshotHistory()` 深拷贝 | ✅ 保留（安全性不能省） |
| 9 种 Hook 类型 | ✅ 保留全部 9 种（为 Phase 8 TUI 做铺垫） |

> **原则**：学参考项目的 **Hook 架构模式**，但根据 cclin 自身架构调整入口参数和集成方式。

### 1.4 最终设计：各文件分工

```
┌──────────────────────────────────────────────────────────────────┐
│                     Phase 7 架构总览                              │
│                                                                  │
│  types.ts            hooks.ts           react-loop.ts            │
│  ┌──────────┐       ┌──────────────┐   ┌──────────────────┐     │
│  │ 约定     │       │ 管理         │   │ 发射             │     │
│  │ 接口规范 │       │ 注册 + 执行  │   │ 在关键节点       │     │
│  │          │       │              │   │ 调用 runHook()   │     │
│  │ Payload  │←─────│ HookRunnerMap│←──│                  │     │
│  │ AgentHooks│      │ buildHookRun│   │ onTurnStart      │     │
│  │ Middleware│      │ runHook()   │   │ onAction         │     │
│  └──────────┘       │ snapshot()  │   │ onObservation    │     │
│                     └──────────────┘   │ onFinal          │     │
│                                        │ onContextUsage   │     │
│  session.ts          index.ts          └──────────────────┘     │
│  ┌──────────┐       ┌──────────────┐                            │
│  │ 构建     │       │ 消费         │                            │
│  │ HookMap  │       │ 注册中间件   │                            │
│  │ 传递给   │       │ （logger）   │                            │
│  │ runTurn  │       │              │                            │
│  └──────────┘       └──────────────┘                            │
└──────────────────────────────────────────────────────────────────┘
```

---

## 第二部分：类型设计 — "先画图纸再盖房"

> 对应源码：[types.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/types.ts) Phase 7 新增部分

### 2.1 思考起点："Hook 系统需要哪些类型？"

Hook 系统的核心问题是：**不同的事件携带不同的数据**。比如：

- `onAction` 需要知道调了哪个工具、输入是什么
- `onFinal` 需要知道最终回答文本、运行状态
- `onContextUsage` 需要知道 token 使用量、阈值

所以第一步是为每种事件定义专属的 **Payload 类型**。

### 2.2 AgentHookHandler — 通用回调签名

```typescript
export type AgentHookHandler<Payload> = (payload: Payload) => Promise<void> | void
```

**为什么支持同步和异步？**

用 `Promise<void> | void` 联合返回类型，handler 可以是同步函数也可以是异步函数：

```typescript
// 同步 handler（简单日志）
const logHandler: AgentHookHandler<ActionHookPayload> = ({ action }) => {
    console.log(`Calling ${action.tool}`)
}

// 异步 handler（写文件、网络请求）
const fileHandler: AgentHookHandler<ActionHookPayload> = async ({ action }) => {
    await fs.appendFile('log.jsonl', JSON.stringify(action))
}
```

`runHook()` 内部用 `await handler(payload)` 调用——对同步函数 await 是无害的（直接返回值），对异步函数正确等待完成。

### 2.3 九种 Payload 类型的设计原则

每个 Payload 都遵循一个模式：

```typescript
type XxxHookPayload = {
    sessionId: string   // 总是有 — 标识哪个会话
    turn: number        // 总是有 — 第几轮
    step?: number       // 可选 — 在循环中的第几步（有些事件不在循环内）
    // ... 事件特有的数据
    history?: ChatMessage[]  // 可选 — 当前历史快照
}
```

**为什么 `sessionId` 和 `turn` 是必选的？**

因为在未来（Phase 10 多 Agent 协作），可能有多个 Session 并行运行。Hook handler 需要知道事件来自哪个 Session 的哪一轮，才能正确路由。提前设计好类型，后续就不用改 handler 的签名了。

**为什么有些 Payload 包含 `history`，有些不包含？**

- `onTurnStart` / `onAction` / `onObservation` 包含 history — 因为 UI 可能需要显示"当前对话状态"
- `onFinal` / `onContextUsage` 不包含 — 因为此时关心的是结果/数值，history 没有额外价值

这是 **按需传递** 原则——不把所有数据都塞进每个 Payload，避免不必要的深拷贝开销。

### 2.4 AgentHooks vs AgentMiddleware — 为什么要两层？

```typescript
// 方式一：直接 hooks（一次性注入）
export type AgentHooks = {
    onTurnStart?: AgentHookHandler<TurnStartHookPayload>
    onAction?: AgentHookHandler<ActionHookPayload>
    // ... 每种 hook 一个可选字段
}

// 方式二：middleware（可叠加多个）
export type AgentMiddleware = AgentHooks & {
    name?: string
}
```

**为什么不只用一种？** 考虑使用场景：

```typescript
// 场景 1：用户只想加一个简单的 onFinal 回调
const session = new Session({
    hooks: { onFinal: ({ finalText }) => console.log(finalText) }
})

// 场景 2：用户要同时加日志器、性能监控、文件记录
const session = new Session({
    middlewares: [
        loggerMiddleware,     // name: 'logger'
        perfMiddleware,       // name: 'perf'
        jsonlMiddleware,      // name: 'jsonl'
    ]
})
```

- `hooks` 适合**开箱即用**的简单场景——直接传函数
- `middlewares` 适合**可插拔**的模块化场景——每个中间件有名字，可独立开发、测试、复用

`AgentMiddleware` 继承自 `AgentHooks`（通过 `&` 交叉类型），所以它拥有所有 hook 字段 + 可选的 `name`。

---

## 第三部分：Hook 引擎 — "广播系统的核心机制"

> 对应源码：[hooks.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/runtime/hooks.ts)

### 3.1 HookPayloadMap — 类型安全的映射魔法

```typescript
export type HookPayloadMap = {
    onTurnStart: TurnStartHookPayload
    onAction: ActionHookPayload
    onObservation: ObservationHookPayload
    // ...
}
```

**为什么需要这个映射？** 因为 `runHook()` 是一个泛型函数：

```typescript
export async function runHook<K extends HookName>(
    map: HookRunnerMap,
    name: K,                    // hook 名称
    payload: HookPayloadMap[K], // ← 自动推导出正确的 Payload 类型！
)
```

当你写 `runHook(map, 'onAction', { ... })` 时，TypeScript 从 `'onAction'` 推导出 `K = 'onAction'`，然后 `HookPayloadMap['onAction']` 就是 `ActionHookPayload`——编译器会强制你传入正确类型的 payload。

如果传错了（比如给 `onAction` 传了 `FinalHookPayload`），**编译时就会报错**，而不是运行时才发现。这就是 TypeScript 映射类型的价值。

### 3.2 HookRunnerMap — 注册表的数据结构

```typescript
export type HookRunnerMap = {
    [K in HookName]: AgentHookHandler<HookPayloadMap[K]>[]
}
```

这是一个 **映射类型**（Mapped Type），展开后等价于：

```typescript
type HookRunnerMap = {
    onTurnStart: AgentHookHandler<TurnStartHookPayload>[]
    onAction: AgentHookHandler<ActionHookPayload>[]
    // ... 每种 hook 对应一个 handler 数组
}
```

用映射类型而不是手写每一行，好处是：
1. **DRY** — 加新 Hook 只需改 `HookName` 和 `HookPayloadMap`，`HookRunnerMap` 自动更新
2. **类型安全** — 数组元素的 handler 类型自动和 payload 对齐

### 3.3 runHook() — 为什么 try/catch 是必须的

```typescript
export async function runHook<K extends HookName>(
    map: HookRunnerMap,
    name: K,
    payload: HookPayloadMap[K],
): Promise<void> {
    const handlers = map[name]
    if (!handlers.length) return  // 快速退出：没有监听者
    for (const handler of handlers) {
        try {
            await handler(payload)
        } catch (err) {
            console.warn(`Hook ${name} failed: ${(err as Error).message}`)
        }
    }
}
```

**关键设计决策：handler 失败不能影响主流程。**

想象场景：一个第三方日志中间件的 `onAction` handler 因为网络超时抛了错。如果这个错误向上冒泡，**整个 ReAct 循环就崩了**——用户正在做的工具调用会中断，任务失败。

所以每个 handler 独立 try/catch，失败只打 warn 日志，循环继续。这是**隔离性**——Hook 系统是"旁观者"，不应该有能力让"主角"（ReAct 循环）崩溃。

### 3.4 snapshotHistory() — 为什么要深拷贝

```typescript
export function snapshotHistory(history: ChatMessage[]): ChatMessage[] {
    return history.map((msg) => {
        if (msg.role === 'assistant' && msg.tool_calls?.length) {
            return {
                ...msg,
                tool_calls: msg.tool_calls.map((tc) => ({
                    ...tc,
                    function: { ...tc.function },
                })),
            }
        }
        return { ...msg }
    })
}
```

**为什么不直接传 `history` 引用？**

Hook handler 是外部代码，你不知道它会不会修改 history 数组。如果有个 handler 做了 `payload.history.push(...)` 或者 `payload.history[0].content = '...'`，就**污染了共享的状态**。

**为什么 tool_calls 需要三层拷贝？**

```
history[i]                ← 第 1 层：message 对象本身
  └── tool_calls[j]       ← 第 2 层：tool_call 对象
        └── function       ← 第 3 层：function 对象（含 name, arguments）
```

`{ ...msg }` 只做浅拷贝——`tool_calls` 数组和其中的 `function` 对象仍然是引用。如果 handler 修改了 `function.arguments`，原始 history 也会被改掉。所以必须逐层展开。

### 3.5 buildHookRunners() — 注册顺序有讲究

```typescript
export function buildHookRunners(
    hooks?: AgentHooks,
    middlewares?: AgentMiddleware[],
): HookRunnerMap {
    const map = emptyHookMap()
    registerMiddleware(map, hooks)         // hooks 先注册
    if (Array.isArray(middlewares)) {
        for (const mw of middlewares) {
            registerMiddleware(map, mw)    // middlewares 按顺序注册
        }
    }
    return map
}
```

注册顺序 = 执行顺序。`hooks` 先注册意味着它的 handler 最先执行。这给了 Session 创建者一个"优先级最高的监听位"。

---

## 第四部分：ReAct 循环改造 — "在关键节点埋入广播点"

> 对应源码：[react-loop.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/runtime/react-loop.ts)

### 4.1 RunTurnDeps 扩展

```typescript
export type RunTurnDeps = {
    // ... 原有字段 ...
    hookRunners?: HookRunnerMap  // Hook 注册表
    sessionId?: string           // Session ID（给 payload 用）
    turnIndex?: number           // 当前轮次（给 payload 用）
}
```

**为什么是可选的？** 向后兼容。没有 Hook 系统的旧代码（Phase 1-6）不传这些参数也能正常运行。`hookRunners` 为空时，所有 `if (hookRunners)` 检查都跳过，零开销。

### 4.2 五个广播点的位置选择

```
runTurn(input, deps)
    │
    ├── history.push(user message)
    │
    ├── 🔔 onTurnStart ← Turn 开始，用户输入已入历史
    │
    └── for (step = 0; step < MAX_STEPS; step++)
            │
            ├── 🔔 onContextUsage ← 每步检测一次 token 使用量
            │
            ├── callLLM() → 解析响应
            │
            ├── if (有工具调用)
            │   ├── for (每个工具)
            │   │   ├── 🔔 onAction ← 工具调用前
            │   │   ├── executeTool()
            │   │   └── 🔔 onObservation ← 工具执行后
            │   └── continue
            │
            └── if (最终回答)
                ├── 🔔 onFinal ← 回答产生
                └── break
```

**为什么 `onAction` 在 `executeTool()` 之前而不是之后？**

因为 UI 需要在工具执行**开始时**就显示"正在调用 xxx..."（比如 spinner 动画）。如果放在执行后，用户会看到工具执行了但之前没有任何提示——体验很差。

**为什么 `onContextUsage` 在每步循环开头？**

因为每步都可能因为工具结果而增加大量 token（比如 `read_file` 返回了一个大文件）。在调用 LLM 前检测，可以及时发现"快爆了"的情况。

### 4.3 守卫模式：`if (hookRunners)`

```typescript
if (hookRunners) {
    await runHook(hookRunners, 'onAction', { ... })
}
```

**为什么不直接调用？** 因为 `hookRunners` 是可选的。如果没有 Hook 系统（比如测试环境），直接调 `runHook(undefined, ...)` 会报错。守卫模式确保：
- 有 Hook 系统 → 正常发射
- 无 Hook 系统 → 跳过，零开销

---

## 第五部分：Session 集成 + 入口中间件

> 对应源码：[session.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/runtime/session.ts) + [index.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/index.ts)

### 5.1 Session 的角色：构建 + 传递

Session 做两件事：

1. **构建**：在构造函数中调用 `buildHookRunners(hooks, middlewares)` 构建注册表
2. **传递**：每次 `runTurn()` 时把注册表传给 `react-loop`

```typescript
constructor(options: SessionOptions) {
    // ...
    this.hookRunners = buildHookRunners(options.hooks, options.middlewares)
}

async runTurn(input: string): Promise<TurnResult> {
    return runTurn(input, {
        // ...
        hookRunners: this.hookRunners,
        sessionId: this.id,
        turnIndex: this.turnIndex,
    })
}
```

**为什么 Session 不自己发射 Hook？**

大部分 Hook 在 ReAct 循环**内部**发射（onAction、onObservation 等）。Session 只负责把注册表"注入"进去。唯一的例外是 `onContextCompacted`——因为 `compactHistory()` 是 Session 的方法，压缩完成后由 Session 直接发射。

### 5.2 loggerMiddleware — 把 console.log 变成中间件

```typescript
const loggerMiddleware: AgentMiddleware = {
    name: 'logger',
    onTurnStart: ({ turn, input }) => {
        console.log(`\n── Turn ${turn} ──`)
        console.log(`  💬 Input: ${input.slice(0, 80)}...`)
    },
    onAction: ({ step, action }) => {
        console.log(`  🔧 [step ${step}] calling tool: ${action.tool}`)
    },
    onObservation: ({ tool, observation }) => {
        const preview = observation.slice(0, 120).replace(/\n/g, ' ')
        console.log(`  📎 [${tool}] ${preview}...`)
    },
    onContextUsage: ({ promptTokens, contextWindow, usagePercent, thresholdTokens }) => {
        if (promptTokens >= thresholdTokens) {
            console.log(`  ⚠️ Context: ${promptTokens}/${contextWindow} (${usagePercent}%)`)
        }
    },
}
```

**对比改造前后**：

| 改造前 | 改造后 |
|--------|--------|
| `react-loop.ts` 里写 `console.log(...)` | `react-loop.ts` 里写 `runHook(...)` |
| 想改输出格式 → 改 react-loop.ts | 想改输出格式 → 改 loggerMiddleware |
| 想加新的输出方式 → 改 react-loop.ts | 想加新的输出方式 → 加新的 middleware |
| 测试时 console.log 污染输出 | 测试时不传 middleware 即可 |

**核心收获**：`react-loop.ts` 的代码从此不再包含任何 `console.log`。它只负责"做事"，"怎么展示"完全由中间件决定。

---

## 第六部分：总结

### 设计原则回顾

| 原则 | 在 Phase 7 中的体现 |
|------|---------------------|
| **开放-封闭** | 新增输出方式（UI/日志/文件）只需加中间件，不改核心代码 |
| **类型安全** | 泛型 `runHook<K>` + `HookPayloadMap` 确保 hook名 ↔ payload 类型一一对应 |
| **隔离性** | handler 独立 try/catch，失败不影响 ReAct 循环 |
| **防御性** | `snapshotHistory()` 深拷贝防止 hook 修改共享状态 |
| **向后兼容** | 所有 hook 相关参数可选，Phase 1-6 代码不受影响 |
| **DRY** | 映射类型 `[K in HookName]: ...` 自动生成注册表类型 |

### 新增/修改文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/types.ts` | 修改 | +110 行：9 种 Payload + AgentHookHandler + AgentHooks + AgentMiddleware |
| `src/runtime/hooks.ts` | **新建** | Hook 引擎：HookRunnerMap + buildHookRunners + runHook + snapshotHistory |
| `src/runtime/react-loop.ts` | 修改 | RunTurnDeps 扩展 + 5 个 runHook 调用点 + 移除 console.log |
| `src/runtime/session.ts` | 修改 | SessionOptions 扩展 + 构造函数构建 HookRunnerMap + onContextCompacted |
| `src/index.ts` | 修改 | loggerMiddleware 中间件 + 传入 Session + Phase 7 banner |

### 完整事件流图

```
用户输入 "列出当前目录的文件"
    │
    ├── Session.runTurn()
    │       ├── runTurn() 进入 react-loop
    │       │       │
    │       │       ├── history.push(user msg)
    │       │       ├── 🔔 onTurnStart → logger: "── Turn 1 ──"
    │       │       │
    │       │       ├── 🔔 onContextUsage → logger: (如超阈值才打印)
    │       │       ├── callLLM() → 返回 tool_use: list_directory
    │       │       │
    │       │       ├── 🔔 onAction → logger: "🔧 calling tool: list_directory"
    │       │       ├── executeTool('list_directory', {...})
    │       │       ├── 🔔 onObservation → logger: "📎 [list_directory] file1.ts..."
    │       │       │
    │       │       ├── callLLM() → 返回 final text
    │       │       ├── 🔔 onFinal → (当前 logger 未处理此 hook)
    │       │       └── return TurnResult
    │       │
    │       └── return result
    │
    └── index.ts 显示: "Assistant: 目录下有以下文件..."
```

**下一步**：Phase 8 将实现 **TUI（Ink）**。届时只需写一个 `inkMiddleware` 替代 `loggerMiddleware`——把 `console.log` 换成 Ink 组件渲染，核心代码（react-loop.ts、session.ts）**零修改**。这就是 Hook 系统的价值。

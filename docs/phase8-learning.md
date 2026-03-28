# Phase 8 学习笔记 — TUI（Ink）

> 这份文档记录了 Phase 8 的每一步做了什么、为什么这样做、思考过程是怎样的。
> 目标：读完后你能**独立从零写出同样的代码**。

---

## 第一部分：宏观理解 — Phase 8 在解决什么问题？

### 1.1 Phase 7 的成果与 Phase 8 的起点

Phase 7 完成后，cclin 有了完整的 Hook 系统。`react-loop.ts` 中不再有任何 `console.log`——所有 UI 展示都通过 `loggerMiddleware` 的 Hook handler 完成。

但 `loggerMiddleware` 仍然是 `console.log`：

```typescript
// index.ts 中的 loggerMiddleware
const loggerMiddleware: AgentMiddleware = {
    name: 'logger',
    onTurnStart: ({ turn, input }) => {
        console.log(`\n── Turn ${turn} ──`)   // 纯文本
    },
    onAction: ({ step, action }) => {
        console.log(`  🔧 [step ${step}] calling tool: ${action.tool}`)   // 纯文本
    },
    // ...
}
```

**问题**：`console.log` 是"写完就忘"的——输出了就不能修改。考虑以下场景：

| 需求 | console.log 的局限 |
|------|-------------------|
| 工具执行中显示 spinner 动画 | 已输出的文字不能替换为 ✅ |
| 实时更新上下文使用量 | 需要覆盖同一行——做不到 |
| 审批时用 UI 组件而非纯文字 | 审批 y/n 和普通输出混在一起 |
| 输入区和输出区分离 | console.log 无法控制布局区域 |

> **Phase 8 的核心任务**：用 Ink（React for CLI）替代 `console.log`，让 UI 变成**可重新渲染的组件树**。工具调用中的 ⏳ 可以变成 ✅，输入框和输出区互不干扰。

### 1.2 什么是 Ink？为什么选它？

Ink 是一个**用 React 语法写终端 UI** 的框架：

```
Web 世界：              终端世界：
React + ReactDOM        React + Ink
  ↓                       ↓
浏览器 DOM              终端字符画布
<div>                   <Box>
<span>                  <Text>
CSS Flexbox             Yoga Layout (Flexbox 子集)
```

选择 Ink 的理由：
1. **React 心智模型**——状态驱动 UI（`useState` → 重新渲染），和 Web 开发一致
2. **组件复用**——输入框、输出区、审批覆盖层都是独立组件
3. **memo-code 验证**——参考项目已经用 Ink 6 验证了这条路径可行
4. **与 Hook 系统天然契合**——Hook 事件 → `setState` → 组件重新渲染

### 1.3 Phase 8 的核心难题：鸡生蛋问题

开始写代码前，我遇到了一个架构难题：

```
Session 需要 middleware → middleware 是 App 组件内部创建的
App 组件需要 onSubmit → onSubmit 内部调用 session.runTurn()
```

- **Session** 的构造函数需要 `middlewares` 参数——因为 Hook 注册表在构造时就构建了
- **App** 组件的 `tuiMiddleware` 是在 React 组件内部用 `useMemo` 创建的——需要先 render App
- 但 **App** 的 `onSubmit` 要调用 `session.runTurn(input)`——需要先有 Session

**这是一个循环依赖。** 解法：**桥接模式（Bridge Pattern）**

```
                    ┌──────────────────────────────────────┐
                    │            index.ts                   │
                    │                                      │
                    │  1. 创建 registry、callLLM、etc.     │
                    │  2. 定义 let session = null           │
                    │  3. render(<App ... />)               │
                    │         │                             │
                    │         ↓                             │
                    │  App 组件初始化                        │
                    │  → 创建 tuiMiddleware                 │
                    │  → 调用 onMiddlewareReady(mw) ────────┤
                    │         │                             │
                    │         ↓                             │
                    │  4. handleMiddlewareReady(mw) 被调用   │
                    │     → 此时才 new Session({ mw })      │
                    │     → session 变量被赋值              │
                    │                                      │
                    │  5. 用户输入 → handleSubmit(input)     │
                    │     → session!.runTurn(input)         │
                    └──────────────────────────────────────┘
```

关键洞察：**Session 不需要在 render 之前创建——只需要在用户第一次输入之前创建**。React 的 `useEffect` 会在首次渲染后同步触发，所以 `onMiddlewareReady` 在用户有机会输入之前就会被调用。

### 1.4 最终设计：各文件分工

```
┌───────────────────────────────────────────────────────────────────┐
│                      Phase 8 架构总览                              │
│                                                                   │
│  index.ts              app.tsx                                    │
│  ┌──────────┐         ┌──────────────────────────┐               │
│  │ 初始化   │         │ 主组件                    │               │
│  │ 资源创建 │         │ ┌─ tuiMiddleware ─────┐   │               │
│  │ 桥接逻辑 │    ←────│ │ onTurnStart → 状态  │   │               │
│  │ render() │    mw   │ │ onAction → 状态     │   │               │
│  └──────────┘         │ │ onObservation → 状态│   │               │
│                       │ │ onFinal → 状态      │   │               │
│                       │ └─────────────────────┘   │               │
│                       │ ┌─ requestApproval ───┐   │               │
│                       │ │ Promise + UI 交互   │   │               │
│                       │ └─────────────────────┘   │               │
│                       └──────────────────────────┘               │
│                              ↓ 组合                              │
│  output.tsx           input.tsx                                   │
│  ┌──────────┐        ┌──────────────┐                            │
│  │ 时间线   │        │ 文本输入     │                            │
│  │ 渲染     │        │ 审批 y/n     │                            │
│  │ 上下文%  │        │ busy 状态    │                            │
│  └──────────┘        └──────────────┘                            │
└───────────────────────────────────────────────────────────────────┘
```

---

## 第二部分：OutputArea — "时间线渲染器"

> 对应源码：[output.tsx](file:///d:/For%20coding/project/Agents/example/cclin/src/tui/output.tsx)

### 2.1 思考起点：时间线需要哪些"条目类型"？

终端界面就是一条**时间线**——按顺序显示发生了什么。我列举了所有可能出现的条目：

```typescript
type TimelineEntry =
    | UserEntry        // 用户说了什么
    | AssistantEntry   // 助手回答了什么
    | ToolEntry        // 工具调用（有状态：running/done/error）
    | SystemEntry      // 系统通知（压缩、错误、Turn 分隔线）
```

**为什么 ToolEntry 有 `status` 字段？** 因为工具调用是**有生命周期的**：
1. `onAction` 触发时 → 添加 `{ status: 'running' }` → 显示 ⏳
2. `onObservation` 触发时 → 更新为 `{ status: 'done' }` → 显示 ✅ + 结果预览
3. 出错时 → 更新为 `{ status: 'error' }` → 显示 ❌

`console.log` 做不到这种"就地更新"——但 React 的 `setState` 可以。这就是 Ink 的核心价值。

### 2.2 updateLastTool — 就地更新的关键

```typescript
const updateLastTool = useCallback((
    name: string,
    status: 'done' | 'error',
    observation?: string,
) => {
    setTimeline(prev => {
        const updated = [...prev]
        // 从后往前找最后一个 running 状态的同名工具
        for (let i = updated.length - 1; i >= 0; i--) {
            const e = updated[i]!
            if (e.type === 'tool' && e.name === name && e.status === 'running') {
                updated[i] = { ...e, status, observation }
                break
            }
        }
        return updated
    })
}, [])
```

**为什么从后往前搜索？** 因为同一个工具可能被多次调用（比如多次 `read_file`）。我们总是要更新**最近的那个** running 条目。

**为什么用 `setTimeline(prev => ...)` 函数式更新？** 因为 Hook handler 是异步调用的——多个 handler 可能在同一个 React 渲染周期内触发。函数式更新确保每次都基于最新状态，避免"丢失更新"问题。

### 2.3 OutputArea 组件设计

```typescript
export function OutputArea({ timeline, contextPercent }: OutputAreaProps) {
    return (
        <Box flexDirection="column" flexGrow={1}>
            {/* 上下文使用量指示 */}
            {contextPercent !== undefined && contextPercent > 0 && (
                <Text dimColor>📊 Context: {contextPercent}%</Text>
            )}
            {/* 时间线渲染 */}
            {timeline.map((entry, i) => {
                switch (entry.type) {
                    case 'user':     return <UserMessage ... />
                    case 'assistant': return <AssistantMessage ... />
                    case 'tool':     return <ToolStatus ... />
                    case 'system':   return <SystemMessage ... />
                }
            })}
        </Box>
    )
}
```

**为什么用 `switch` 而不是 `if-else`？** 因为 TypeScript 的**穷举检查**——`TimelineEntry` 是联合类型，`switch` 会确保每个 `type` 都被处理。如果后续加了新类型忘了加分支，编译器会报错。

---

## 第三部分：InputArea — "三态输入组件"

> 对应源码：[input.tsx](file:///d:/For%20coding/project/Agents/example/cclin/src/tui/input.tsx)

### 3.1 三种模式的设计

InputArea 有**三种互斥的显示模式**：

```
┌─────── 正常模式 ───────┐    ┌─── busy 模式 ───┐    ┌──── 审批模式 ────┐
│ You: [文本输入框]      │    │ ⏳ 思考中...    │    │ 🔐 write_file:   │
│                        │    │                  │    │    写入 foo.ts    │
│ (可输入，回车提交)     │    │ (输入被禁用)     │    │    按 y 允许,     │
└────────────────────────┘    └──────────────────┘    │    n 拒绝         │
                                                      └──────────────────┘
```

**为什么不把三种模式做成三个组件？** 因为它们**共享同一个虚拟 DOM 位置**。如果用三个组件在外层 switch，React 会销毁旧组件、创建新组件——输入框的状态（正在输入的文本）会丢失。保持一个组件内部 switch，状态通过 `useState` 持久保存。

### 3.2 useInput — Ink 的键盘监听

```typescript
useInput((input, _key) => {
    if (!approvalPending || !onApproval) return
    if (input === 'y' || input === 'Y') {
        onApproval(true)
    } else if (input === 'n' || input === 'N') {
        onApproval(false)
    }
}, { isActive: !!approvalPending })
```

**为什么用 `isActive` 控制？** Ink 的 `useInput` 是全局键盘监听——如果两个组件都注册了 `useInput`，**都会收到按键事件**。`isActive: false` 让 hook 在非审批模式下"休眠"，不会误拦截正常输入的 y/n 键。

**对比 readline 的做法**：

| readline 审批 | Ink 审批 |
|---|---|
| `rl.question('允许? (y/n): ', callback)` | `useInput` + `setPendingApproval` |
| 阻塞式——其他输入被暂停 | 声明式——UI 自动切换为审批模式 |
| 输出和输入混在一起 | 审批 UI 独立于时间线 |

---

## 第四部分：App — "Hook 事件与 UI 状态的桥梁"

> 对应源码：[app.tsx](file:///d:/For%20coding/project/Agents/example/cclin/src/tui/app.tsx) + [index.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/index.ts)

### 4.1 思考起点：如何把 Hook 事件"翻译"成 UI 状态？

Phase 7 的 Hook 系统发射**事件**（`onAction`、`onFinal`...），但 React 的 UI 是**状态驱动**的。需要一个"翻译层"：

```
Hook 事件                           React 状态
────────                           ────────
onTurnStart({ turn, input })   →   timeline.push(UserEntry)
                                    busy = true

onAction({ action })           →   timeline.push(ToolEntry { running })

onObservation({ tool, obs })   →   timeline 中最后一个 running tool → done

onFinal({ finalText })         →   timeline.push(AssistantEntry)
                                    busy = false

onContextUsage({ percent })    →   contextPercent = percent
```

这个"翻译层"就是 `tuiMiddleware`——一个 `AgentMiddleware` 对象。

### 4.2 tuiMiddleware — 关键代码解读

```typescript
const tuiMiddleware = React.useMemo<AgentMiddleware>(() => ({
    name: 'tui',
    onTurnStart: ({ turn, input }) => {
        setBusy(true)
        addEntry({ type: 'system', text: `── Turn ${turn} ──`, tone: 'info' })
        addEntry({ type: 'user', text: input })
    },
    onAction: ({ action }) => {
        addEntry({ type: 'tool', name: action.tool, status: 'running' })
    },
    onObservation: ({ tool, observation }) => {
        updateLastTool(tool, 'done', observation)
    },
    onFinal: ({ finalText }) => {
        addEntry({ type: 'assistant', text: finalText })
        setBusy(false)
    },
    // ...
}), [addEntry, updateLastTool])
```

**为什么用 `useMemo` 而不是直接定义？** 因为 React 每次渲染都会重新执行组件函数体——如果每次都创建新的 middleware 对象，`onMiddlewareReady` 回调会被反复调用。`useMemo` 确保只在依赖变化时重新创建。

**对比 Phase 7 的 loggerMiddleware**：

| loggerMiddleware | tuiMiddleware |
|---|---|
| `console.log(...)` | `addEntry(...)` / `setBusy(...)` |
| 写完就忘 | 更新到 React 状态，UI 重新渲染 |
| 不能修改已输出内容 | 可以通过 `updateLastTool` 就地更新 |
| 全靠文本颜色 | 可用 Ink 组件实现复杂布局 |

### 4.3 审批：从 rl.question 到 Promise + 状态

Phase 7 的审批是这样的：

```typescript
// Phase 7 的 readline 审批
rl.question('允许执行? (y/n): ', (answer) => {
    const decision = answer === 'y' ? 'approve' : 'deny'
    resolve(decision)
})
```

Phase 8 改为**状态驱动**：

```typescript
// Phase 8 的 Ink 审批
const requestApproval = (req: ApprovalRequest): Promise<ApprovalDecision> => {
    return new Promise(resolve => {
        setApprovalText(`${req.toolName}: ${req.reason}`)  // 更新 UI
        setApprovalPending(true)                           // 切换到审批模式
        approvalResolver.current = resolve                 // 保存 resolve 函数
    })
}
```

**流程**：
1. 工具编排器调用 `requestApproval(req)` → 返回一个 Promise（还没 resolve）
2. `setApprovalPending(true)` → InputArea 切换为审批模式（显示 y/n）
3. 用户按 y → `handleApproval(true)` → 调用 `approvalResolver.current('approve')` → Promise resolve
4. UI 恢复为 busy 模式（工具继续执行）

**为什么用 `useRef` 保存 resolve？** 因为 `resolve` 只需要被调用一次，不需要触发重新渲染。`useState` 会在每次更新时触发渲染——浪费。`useRef` 是"不触发渲染的可变容器"。

### 4.4 Bridge Pattern 在 index.ts 中的实现

```typescript
// index.ts 核心桥接逻辑

let session: Session | null = null           // 延迟初始化
let requestApprovalFn = null                 // 审批回调（来自 App）

// App 渲染后回调
const handleMiddlewareReady = (mw: AgentMiddleware) => {
    session = new Session({                  // 此时才创建 Session
        // ...
        middlewares: [mw],                   // mw 来自 App 组件
        // ...
    })
}

const handleApprovalReady = (fn) => {
    requestApprovalFn = fn                   // 保存 App 的审批函数
}

// Ink 渲染
render(React.createElement(App, {
    onSubmit: handleSubmit,                  // handleSubmit 内部用 session
    onMiddlewareReady: handleMiddlewareReady,
    onApprovalReady: handleApprovalReady,
}))
```

**关键时序**：
1. `render()` 被调用 → App 组件**同步**渲染（首次渲染）
2. React 首次渲染后 → `useEffect` 触发 → 调用 `onMiddlewareReady` 和 `onApprovalReady`
3. `handleMiddlewareReady` 执行 → `session` 被赋值
4. 用户**此时才有机会输入**（因为事件循环到此刻才空闲）
5. 用户输入 → `handleSubmit` → `session.runTurn(input)` → **session 已就绪**

**为什么不用 React.createElement 而不是 JSX？** 因为 `index.ts` 是 `.ts` 文件（不是 `.tsx`），TypeScript 不会在 `.ts` 文件中处理 JSX 语法。用 `React.createElement` 在纯 `.ts` 文件中也能创建 React 元素。

---

## 第五部分：总结

### Phase 7 → Phase 8 的本质飞跃

```
Phase 7: event → console.log (一次性输出，不可更新)
Phase 8: event → setState → 组件重新渲染 (声明式、可更新)
```

**核心代码零修改的证据**：
- `react-loop.ts` — 0 行修改
- `session.ts` — 0 行修改
- `hooks.ts` — 0 行修改
- `types.ts` — 0 行修改

**只改了 `index.ts`**（入口）和**新增了 3 个 TUI 文件**。这就是 Phase 7 Hook 系统的设计回报——新增一种 UI 方式，只需要写一个新的 middleware，核心逻辑完全不动。

### 设计原则回顾

| 原则 | 在 Phase 8 中的体现 |
|------|---------------------|
| **开放-封闭** | 新增 TUI 只需新增 tuiMiddleware + 组件文件，不改核心代码 |
| **桥接模式** | index.ts 用延迟初始化解决 Session ↔ App 循环依赖 |
| **状态驱动 UI** | Hook 事件 → setState → 自动重新渲染，不手动操作"屏幕" |
| **函数式更新** | `setTimeline(prev => ...)` 避免异步竞态丢失更新 |
| **三态设计** | InputArea 的 normal/busy/approval 三种模式互斥切换 |
| **Ref vs State** | `approvalResolver` 用 ref（不需要渲染），timeline 用 state（需要渲染） |

### 新增/修改文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `package.json` | 修改 | +ink +react +ink-text-input +@types/react |
| `tsconfig.json` | 修改 | +jsx: react-jsx |
| `src/tui/output.tsx` | **新建** | 时间线渲染：4 种条目类型 + OutputArea 组件 |
| `src/tui/input.tsx` | **新建** | 三态输入：normal + busy + approval |
| `src/tui/app.tsx` | **新建** | 主组件：tuiMiddleware + 审批逻辑 + 布局 |
| `src/index.ts` | **重写** | readline → Ink render + Bridge Pattern |
| `PLAN.md` | 修改 | Phase 8 标记完成 |

### 完整事件流图

```
用户输入 "列出当前目录的文件"
    │
    ├── InputArea.onSubmit() → handleSubmit(input)
    │       │
    │       ├── session.runTurn(input)
    │       │       │
    │       │       ├── react-loop 中 runHook('onTurnStart', ...)
    │       │       │       └── tuiMiddleware.onTurnStart()
    │       │       │               ├── setBusy(true) → InputArea 切换为 "⏳ 思考中..."
    │       │       │               └── addEntry(UserEntry) → OutputArea 显示用户消息
    │       │       │
    │       │       ├── callLLM() → list_directory 工具调用
    │       │       │
    │       │       ├── runHook('onAction', ...)
    │       │       │       └── tuiMiddleware.onAction()
    │       │       │               └── addEntry(ToolEntry { running })
    │       │       │                       → OutputArea 显示 "⏳ list_directory"
    │       │       │
    │       │       ├── executeTool('list_directory')
    │       │       │
    │       │       ├── runHook('onObservation', ...)
    │       │       │       └── tuiMiddleware.onObservation()
    │       │       │               └── updateLastTool('list_directory', 'done', result)
    │       │       │                       → OutputArea 更新为 "✅ list_directory"
    │       │       │
    │       │       ├── callLLM() → 最终回答
    │       │       │
    │       │       └── runHook('onFinal', ...)
    │       │               └── tuiMiddleware.onFinal()
    │       │                       ├── addEntry(AssistantEntry)
    │       │                       │       → OutputArea 显示助手回答
    │       │                       └── setBusy(false)
    │       │                               → InputArea 恢复为输入模式
    │       │
    │       └── return
    │
    └── 用户看到完整的时间线 + 输入框恢复
```

**下一步**：Phase 9 将实现**工具路由 & MCP**。届时只需在 `index.ts` 中增加 `McpToolRegistry` 和 `ToolRouter`——TUI 代码（`app.tsx` / `output.tsx` / `input.tsx`）同样**零修改**。

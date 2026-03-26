# Phase 6 学习笔记 — 上下文压缩（Context Compression）

> 这份文档记录了 Phase 6 的每一步做了什么、为什么这样做、思考过程是怎样的。
> 目标：读完后你能**独立从零写出同样的代码**。

---

## 第一部分：宏观理解 — Phase 6 在解决什么问题？

### 1.1 Phase 5 的现状与不足

Phase 5 完成后，我们的 agent 已经有了完整的系统提示词动态组装：

```
用户输入 → 系统提示词(模板+AGENTS.md+SOUL.md) → LLM → 工具调用 → 审批 → 执行 → 观察 → LLM → 最终回答
```

但有一个隐藏的定时炸弹——**对话历史无限增长**：

```
Turn 1: 系统消息 + 用户消息 + 助手消息                     ≈ 2,000 tokens
Turn 5: + 多轮工具调用和结果                                ≈ 20,000 tokens
Turn 20: + 大量文件读取和命令输出                           ≈ 100,000 tokens
Turn 25: 💥 超出 128k context window → API 报错 / 截断
```

LLM 的上下文窗口就像一个固定大小的"工作台"。对话历史堆在上面，堆满了就没法继续。

> **Phase 6 的核心任务**：在工作台快满时，把旧文件整理成一份"摘要备忘录"，腾出空间继续工作。

### 1.2 从参考项目（memo-code）学到了什么

开始写代码前，我研究了 memo-code 的压缩系统：

```
memo-code 的压缩系统：
├── utils/tokenizer.ts       — tiktoken WASM 封装（77行）
├── runtime/compact_prompt.ts — 压缩提示词和历史转换（56行）
└── runtime/session_runtime.ts — 压缩集成到 ReAct 循环
    ├── compactHistoryInternal()  — 核心压缩流程
    ├── buildCompactedHistory()   — 重建压缩后历史
    ├── checkContextUsage()       — 每步检测 token 使用量
    └── resolveThresholdTokens()  — 计算阈值
```

**memo-code 做了很多我们暂时不需要的事**：

| memo-code 有的 | cclin Phase 6 取舍 |
|---|---|
| @dqbd/tiktoken（WASM 原生绑定） | ❌ 换成 gpt-tokenizer（纯 JS，零编译） |
| 保留最近 N 条 user 消息 | ❌ 简化（只保留 system + 摘要） |
| 压缩后二次检测（仍超限则截断） | ❌ 简化（当前只日志警告） |
| Hook 事件（onContextCompacted） | ❌ Phase 7 的事 |
| 压缩与 ReAct 深度耦合 | ✅ 解耦：Session 负责压缩，loop 只做检测 |
| LLM 驱动的历史摘要 | ✅ 保留（核心特性） |
| 手动 /compact 命令 | ✅ 保留 |

> **原则**：学参考项目的**压缩管线模式**，简化不需要的复杂度，保持代码可以独立理解。

### 1.3 最终设计：三模块分工

```
┌──────────────────────────────────────────────────────────────┐
│                    Phase 6 架构总览                           │
│                                                              │
│  tokenizer.ts          compaction.ts         session.ts       │
│  ┌──────────┐         ┌──────────────┐     ┌──────────────┐  │
│  │ 数多少   │         │ 怎么压       │     │ 何时压       │  │
│  │ token？  │         │ 缩历史？     │     │ + 谁来调？   │  │
│  │          │         │              │     │              │  │
│  │ countText│         │ SYSTEM_PROMPT│     │compactHistory│  │
│  │ countMsg │         │ buildPrompt  │     │  ↑ /compact  │  │
│  │          │         │ buildHistory │     │  ↑ 自动检测  │  │
│  └──────────┘         └──────────────┘     └──────────────┘  │
│       ↑                      ↑                    ↑          │
│       └──────── Session 统一调度 ─────────────────┘          │
└──────────────────────────────────────────────────────────────┘
```

---

## 第二部分：Token 计数器 — 知道"还剩多少空间"

> 对应源码：[tokenizer.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/utils/tokenizer.ts)

### 2.1 思考起点："选哪个 tokenizer 库？"

Token 计数器的作用是**本地估算**当前历史消耗了多少 token，不用真的发 API 请求。

可选方案：

| 方案 | 优点 | 缺点 |
|------|------|------|
| `@dqbd/tiktoken` | 精确（OpenAI 官方算法） | 需要 WASM/native 编译，安装可能失败 |
| `gpt-tokenizer` | 纯 JS，零编译，npm install 即用 | 与 tiktoken 有微小差异（< 1%） |
| 粗估（字符数 / 4） | 零依赖 | 太不精确，尤其中文场景偏差大 |

我选了 **gpt-tokenizer**。核心理由：

1. **学习项目优先"能跑"**：不想因为 WASM 编译问题卡住
2. **精度足够**：估算的目的是"大概知道用了多少"，不需要精确到每个 token
3. **API 兼容**：`encode(text)` 返回 token 数组，和 tiktoken 一样

### 2.2 ChatML 开销是什么？

LLM API 不是直接把你的文字发过去。实际发送的是 **ChatML 格式**：

```
<|im_start|>system
You are a helpful assistant.<|im_end|>
<|im_start|>user
Hello!<|im_end|>
<|im_start|>assistant
```

每条消息都会加上角色标记和分隔符。OpenAI 估算：
- **每条消息 +4 tokens**（角色标记 + 分隔符开销）
- **助手回复起始 +2 tokens**（`<|im_start|>assistant`）

所以 `countMessages` 的计算方式是：

```typescript
let total = 0
for (const message of messages) {
    total += TOKENS_PER_MESSAGE        // +4
    total += countText(payload)        // 消息内容本身
}
total += TOKENS_FOR_ASSISTANT_PRIMING  // +2
```

### 2.3 为什么不同 role 的消息要不同处理？

```typescript
function messagePayloadForCounting(message: ChatMessage): string {
    if (message.role === 'assistant') {
        // assistant 可能含 reasoning_content 和 tool_calls
        // 这些都会消耗 token，必须计入
    }
    if (message.role === 'tool') {
        // tool 消息含 tool_call_id 和 name
        // 也占 token 空间
    }
    return message.content  // system / user 直接取内容
}
```

**关键洞察**：assistant 消息并不只有 `content` 字段。如果它调用了工具，`tool_calls` 数组（包含函数名、参数 JSON）也是 API payload 的一部分，必须计入 token 估算。

### 2.4 为什么用工厂函数而不是类？

```typescript
// ✅ 选择了工厂函数
export function createTokenCounter(): TokenCounter { ... }

// ❌ 没用类
export class TokenCounterImpl implements TokenCounter { ... }
```

理由：TokenCounter 没有需要继承的行为，也没有复杂的内部状态。工厂函数返回一个简单的接口对象，代码更短，也和 memo-code 的 `createTokenCounter` 保持一致。

---

## 第三部分：压缩模块 — "让 LLM 帮你做笔记"

> 对应源码：[compaction.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/runtime/compaction.ts)

### 3.1 思考起点："压缩的本质是什么？"

想象你在做项目，桌子上堆满了文件。你可以：

1. **直接丢掉旧文件** → 丢失了信息，可能后面要用
2. **写一份摘要备忘录，然后把原件归档** → 保留关键信息，释放空间

我们选择方案 2——**让 LLM 自己总结对话历史**。因为 LLM 最懂哪些信息对后续任务重要。

### 3.2 压缩系统提示词的设计

```typescript
export const CONTEXT_COMPACTION_SYSTEM_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`
```

**为什么说"给另一个 LLM 接手"？**

这个措辞是故意的——压缩后，原始 LLM 的"记忆"被清空了，后续的回答相当于一个"新 LLM"在接手。用"handoff summary"的比喻，让 LLM 生成的摘要更有交接文档的结构感：有进展、有决策、有下一步。

### 3.3 消息转文本的设计

压缩时，需要把 `ChatMessage[]` 转为 LLM 能阅读的文本。格式设计：

```
[0] SYSTEM
You are a helpful coding assistant...

[1] USER
帮我写一个排序算法

[2] ASSISTANT (tool_calls: read_file)
我来先看看现有代码...

[3] TOOL (read_file)
function sort(arr) { ... }
```

**为什么不直接 JSON.stringify？**

1. JSON 太冗长，浪费 token
2. 人类可读的格式让 LLM 更容易理解对话脉络
3. `[index] ROLE` 的索引帮助 LLM 追踪对话顺序

**为什么要截断长内容？**

```typescript
const MAX_MESSAGE_CONTENT_CHARS = 4_000
```

工具返回的内容可能非常大（比如 `read_file` 读了一个 1MB 的文件）。如果不截断，压缩请求本身可能就超出上下文窗口——变成了"为了压缩而爆掉"的荒诞局面。

### 3.4 摘要检测：避免"摘要套摘要"

```typescript
export const CONTEXT_SUMMARY_PREFIX =
    'Another language model started to solve this problem...'

export function isContextSummaryMessage(message: ChatMessage): boolean {
    if (message.role !== 'user') return false
    return message.content.startsWith(`${CONTEXT_SUMMARY_PREFIX}\n`)
}
```

**为什么需要这个？** 考虑连续压缩的场景：

```
第一次压缩：[system, 20条对话] → [system, 摘要A]
更多对话后...
第二次压缩：[system, 摘要A, 10条新对话] → [system, 摘要B]
```

第二次压缩时，摘要A 会出现在历史中。`isContextSummaryMessage` 让后续逻辑（Phase 7 的 Hook 等）能识别"这不是用户原始输入，而是之前的压缩摘要"。

### 3.5 历史重建：压缩后的新数组

```typescript
export function buildCompactedHistory(
    systemMessage: ChatMessage | undefined,
    summary: string,
): ChatMessage[] {
    const summaryMessage: ChatMessage = {
        role: 'user',
        content: `${CONTEXT_SUMMARY_PREFIX}\n${summary}`,
    }
    if (systemMessage) {
        return [systemMessage, summaryMessage]
    }
    return [summaryMessage]
}
```

压缩后，历史从可能的 50+ 条消息变为 **2 条**：
1. 原始的 system 消息（规则不能丢）
2. 一条 user 消息，内容是摘要（带前缀标识）

**为什么摘要是 user 角色而不是 system？**

因为 system 只应有一条（系统规则），摘要更像是"任务交接信息"，放在 user 角色下更符合 ChatML 的语义——用户在告诉新 LLM："之前有人做了这些工作"。

---

## 第四部分：Session 集成 — "谁负责按下压缩按钮？"

> 对应源码：[session.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/runtime/session.ts) + [react-loop.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/runtime/react-loop.ts)

### 4.1 架构决策："压缩逻辑放在哪里？"

这是 Phase 6 最重要的设计决策。有两个选择：

**方案 A：放在 react-loop.ts（memo-code 的做法）**
```
react-loop 检测 token 超限 → react-loop 直接调 LLM 压缩 → react-loop 重建历史
```
- 优点：所有逻辑在一个文件中
- 缺点：react-loop 的职责膨胀（已经有 Think/Act/Observe，再加压缩）

**方案 B：放在 session.ts（我们的做法）**
```
react-loop 只检测 + 日志警告 → Session.compactHistory() 执行压缩
index.ts /compact 命令 → Session.compactHistory() 执行压缩
```
- 优点：Session 管理状态（history），压缩就是状态操作，职责对齐
- 缺点：需要两个文件协调

我选了 **方案 B**，因为：
1. `react-loop.ts` 是**纯函数**（接收 deps，返回 result），不应该有"修改外部状态"的副作用
2. Session **拥有** history 数组，压缩本质是"重建 history"，应该由所有者操作
3. 手动 `/compact` 命令也需要调压缩，放在 Session 更容易复用

### 4.2 Session 新增的配置

```typescript
export type SessionOptions = {
    callLLM: CallLLM
    systemPrompt?: string
    executeTool?: ExecuteTool
    sessionId?: string
    // Phase 6 新增 ↓
    tokenCounter?: TokenCounter    // token 计数器
    contextWindow?: number         // 上下文窗口大小（默认 128000）
    compactThreshold?: number      // 自动压缩阈值%（默认 80）
}
```

**为什么都是可选的？**

向后兼容。Phase 1-5 的代码不传这些参数也能正常运行，只是没有压缩能力。这是一个重要的设计原则：**新功能应该是增量的，不应该破坏已有代码**。

### 4.3 compactHistory() 的执行流程

```
compactHistory('manual' | 'auto')
    │
    ├── 无 tokenCounter？→ 返回 { status: 'skipped' }
    │
    ├── 计算 beforeTokens
    │
    ├── 提取 systemMessage（history[0] if role='system'）
    │
    ├── historyWithoutSystem 为空？→ 返回 { status: 'skipped' }
    │
    ├── 调用 LLM 生成摘要
    │   ├── system = CONTEXT_COMPACTION_SYSTEM_PROMPT
    │   └── user = buildCompactionUserPrompt(historyWithoutSystem)
    │
    ├── 提取摘要文本（过滤 text blocks → join → trim）
    │
    ├── 重建历史：history.splice(0, length, ...newHistory)
    │
    ├── 计算 afterTokens 和 reductionPercent
    │
    └── 返回 CompactResult
```

### 4.4 history.splice 的精妙用法

```typescript
this.history.splice(0, this.history.length, ...compactedHistory)
```

这一行做了三件事：
1. 从索引 0 开始
2. 删除**全部**元素（`this.history.length` 个）
3. 插入新的 `compactedHistory` 数组

**为什么不直接 `this.history = compactedHistory`？**

因为 `history` 是 `readonly` 属性——构造时用 `readonly history: ChatMessage[] = []` 声明。`readonly` 阻止重新赋值，但不阻止就地修改（push, splice 等）。这保证了外部持有的 history 引用不会断裂——无论是 Session 还是 runTurn 中的 deps.history，都指向同一个数组。

### 4.5 ReAct 循环中的检测逻辑

```typescript
// react-loop.ts 中的检测
if (tokenCounter && contextWindow && compactThreshold) {
    const currentTokens = tokenCounter.countMessages(history)
    const thresholdTokens = Math.floor(
        contextWindow * (compactThreshold / 100),
    )
    if (currentTokens >= thresholdTokens) {
        console.log(`  ⚠️ Context usage: ... exceeds threshold`)
    }
}
```

当前设计中，ReAct 循环**只做检测和日志**，不直接触发压缩。这是有意的简化——自动压缩的完整集成（自动调用 `compactHistory`）需要 Phase 7 的 Hook 系统来优雅实现，否则 react-loop 需要反向引用 Session，破坏了当前的"纯函数"设计。

---

## 第五部分：入口集成 — /compact 命令和上下文显示

> 对应源码：[index.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/index.ts) 的修改

### 5.1 新增的启动流程

```typescript
// Phase 6 新增：创建 Token 计数器
const tokenCounter = createTokenCounter()

const session = new Session({
    callLLM,
    systemPrompt,
    executeTool: orchestrator.createExecuteTool({ ... }),
    // Phase 6 新增 ↓
    tokenCounter,
    contextWindow: 128_000,
    compactThreshold: 80,
})
```

**为什么 128_000？** 这是当前主流模型（GPT-4o、DeepSeek）的上下文窗口大小。数字中的下划线 `_` 是 TypeScript 的数字分隔符，纯粹为了可读性（`128_000` 比 `128000` 更一目了然）。

**为什么 80%？** 留 20% 缓冲。如果 80% 时就开始压缩，还剩约 25k tokens 的空间给 LLM 继续"想"和"做"。设太高（如 95%）风险大——压缩本身需要调 LLM，如果此时已经 95% 了，压缩请求本身可能又叠加上去导致超限。

### 5.2 /compact 命令实现

```typescript
if (trimmed === '/compact') {
    console.log('\n📦 正在压缩上下文...')
    const result = await session.compactHistory('manual')
    if (result.status === 'success') {
        console.log(`   ✅ 压缩成功: ${result.beforeTokens} → ${result.afterTokens} tokens`)
    } else if (result.status === 'skipped') {
        console.log(`   ⚠️ 跳过压缩: ${result.errorMessage ?? '无可压缩内容'}`)
    } else {
        console.log(`   ❌ 压缩失败: ${result.errorMessage}`)
    }
    prompt()   // 不进入 runTurn，直接回到输入
    return
}
```

**关键点**：`/compact` 是一个**旁路命令**，不经过 ReAct 循环。用户输入 `/compact` 后，直接调用 `session.compactHistory()`，显示结果，然后回到输入等待。这和 `exit` 命令的处理方式一致——是 UI 层的交互逻辑，不是 agent 的思考过程。

### 5.3 资源清理

```typescript
if (!trimmed || trimmed.toLowerCase() === 'exit') {
    console.log('Bye! 👋')
    tokenCounter.dispose()  // Phase 6 新增：释放 tokenizer 资源
    rl.close()
    return
}
```

虽然 `gpt-tokenizer` 的 `dispose()` 当前是空操作（纯 JS 实现不需要释放资源），但保留这个调用是好习惯——如果将来换成 tiktoken（需要释放 WASM 内存），代码不用改。

---

## 第六部分：总结

### 设计原则回顾

| 原则 | 在 Phase 6 中的体现 |
|------|---------------------|
| **关注点分离** | tokenizer（计数）、compaction（转换）、session（调度）三个模块各司其职 |
| **向后兼容** | 所有新配置都是可选的，不传也能用 |
| **防御性编程** | 截断过长消息、处理空摘要、捕获 LLM 错误 |
| **KISS** | 没用复杂的 tiktoken WASM，用纯 JS 方案 |
| **为未来设计** | `dispose()` 接口、`isContextSummaryMessage` 检测、Phase 7 Hook 的预留 |

### 完整数据流图

```
                   正常对话流程
                   ───────────
   用户输入 → Session.runTurn()
                ↓
        history.push(user msg)
                ↓
        ┌─── ReAct 循环 ───┐
        │ 检测 token 使用量  │ ← tokenCounter.countMessages()
        │     ↓              │
        │ 调用 LLM           │
        │     ↓              │
        │ 解析响应            │
        │     ↓              │
        │ 工具调用 or 最终回答│
        └────────────────────┘
                ↓
          返回 TurnResult


               手动压缩流程
               ───────────
   用户输入 /compact
        ↓
   Session.compactHistory('manual')
        ↓
   tokenCounter 计算 beforeTokens
        ↓
   提取 systemMessage + historyWithoutSystem
        ↓
   调用 LLM（压缩专用 prompt）
        ↓
   LLM 生成摘要文本
        ↓
   buildCompactedHistory(system, summary)
        ↓
   history.splice(0, length, ...newHistory)
        ↓
   返回 CompactResult（含 before/after/reduction%）
```

### 新增/修改文件清单

| 文件 | 操作 | 行数 | 说明 |
|------|------|------|------|
| `src/types.ts` | 修改 | +40 | TokenCounter, CompactReason, CompactResult |
| `src/utils/tokenizer.ts` | **新建** | 80 | gpt-tokenizer 封装 |
| `src/runtime/compaction.ts` | **新建** | 141 | 压缩提示词 + 历史转换 + 重建 |
| `src/runtime/session.ts` | 修改 | +115 | compactHistory() + 配置 |
| `src/runtime/react-loop.ts` | 修改 | +15 | Token 使用量检测 |
| `src/index.ts` | 修改 | +20 | /compact 命令 + tokenCounter |

**下一步**：Phase 7 将实现 **Hook / 中间件系统**，届时可以将自动压缩做成一个 Hook——当 `onContextUsage` 检测到超限时，自动触发 `compactHistory`，而无需修改 ReAct 循环的核心代码。

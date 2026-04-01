# Phase 2 学习笔记 — 手写 ReAct 循环

> 这份文档记录了 Phase 2 的每一步做了什么、为什么这样做、思考过程是怎样的。
> 目标：读完后你能**独立从零写出同样的代码**。

---

## 第一部分：宏观理解 — Phase 2 在干什么？

### 1.1 Phase 1 的现状

Phase 1 完成后，我们有这些东西：

```
src/
├── index.ts        ← readline REPL，直接调用 callLLM
├── types.ts        ← ChatMessage, LLMResponse 等基础类型
└── llm/
    └── client.ts   ← OpenAI SDK 封装，createCallLLM 工厂函数
```

Phase 1 的交互模式是 **"一问一答"**：

```
用户输入 → callLLM(history) → 拿到文本 → 打印
```

这很简单，但这 **不是 Agent**。Agent 需要能 **自己决定下一步做什么**。

### 1.2 什么是 ReAct 循环？

ReAct = **Re**asoning + **Act**ing。核心思想是让 LLM 在一个循环里交替进行：

```
Think（思考）→ Act（行动）→ Observe（观察结果）→ Think → Act → ...
```

直到 LLM 认为任务完成，给出最终回答。

**具体在代码里的表现**：

```
用户："帮我创建一个 hello.txt 文件"

Step 0: LLM 思考 → 决定调用 write_file 工具
Step 1: 执行 write_file → 得到结果 "文件已创建"
Step 2: LLM 看到结果 → 给出最终回答 "我已经帮你创建了 hello.txt"
```

关键区别：Phase 1 是 **一次** LLM 调用；Phase 2 是 **循环调用**，直到不再需要工具。

### 1.3 Phase 2 的精简策略

memo-code 的 `session_runtime.ts` 有 **1237 行**，因为它要处理：
- 上下文压缩（auto-compact）
- Hook 生命周期
- 审批流程
- 并发工具执行
- 协议违规检测
- 历史事件日志
- ...

我们的 Phase 2 只做 **骨架**：
- ✅ ReAct 循环（Think → Act → Observe）
- ✅ 响应解析（判断是工具调用还是最终回答）
- ✅ Session 状态管理（多轮历史）
- ❌ 真实工具（Phase 3）
- ❌ 审批（Phase 4）
- ❌ 上下文压缩（Phase 6）
- ❌ Hook 系统（Phase 7）

> **思考方式**：先做能跑的最小循环，后续 Phase 逐步填充。
> 这就像搭房子——先搭框架，再砌墙、装修。

---

## 第二部分：类型设计 — 先想清楚数据长什么样

### 2.1 思考起点："循环里流转的数据是什么？"

在写任何逻辑之前，我先问自己：**ReAct 循环里，数据是怎么流动的？**

```
LLM 返回响应（LLMResponse）
    ↓
解析：这是工具调用？还是最终回答？（ParsedAssistant）
    ↓
如果是工具调用 → 执行工具 → 得到结果（observation）
如果是最终回答 → 结束循环
    ↓
每一步都要记录下来（AgentStepTrace）
    ↓
整轮结束后，返回一个总结果（TurnResult）
```

所以需要 4 个新类型。让我逐个讲。

### 2.2 `ParsedAssistant` — LLM 到底想干嘛？

```typescript
export type ParsedAssistant = {
    action?: { tool: string; input: unknown }
    final?: string
    thinking?: string
}
```

**为什么这样设计？**

LLM 的响应是 `ContentBlock[]`（文本块 + 工具调用块的混合数组）。但对于循环逻辑来说，我们只关心两件事：

1. **它是否在请求工具调用？** → `action`
2. **它是否在给最终回答？** → `final`

把 `ContentBlock[]` 这种 "低层格式" 转成 `ParsedAssistant` 这种 "高层语义"，就是 **解析** 的本质。

**`action` 和 `final` 的互斥关系**：
- 有 `action` → 继续循环
- 有 `final` → 结束循环
- 两者都没有 → 异常，退出防死循环

**`thinking` 是什么？** 有时候 LLM 在工具调用的同时也输出了文字（比如 "让我来读一下这个文件"），这部分文字不是最终回答，而是思考过程，所以单独存放。

> **对标 memo-code**：[memo-code 的 ParsedAssistant](file:///D:/For%20coding/project/Agents/example/memo-code/packages/core/src/types.ts#L143-L150) 结构完全一样。

### 2.3 `AgentStepTrace` — 每一步都要留痕

```typescript
export type AgentStepTrace = {
    index: number
    assistantText: string
    parsed: ParsedAssistant
    observation?: string
    tokenUsage?: Partial<TokenUsage>
}
```

**思考过程**：循环可能跑很多步。如果出了问题，怎么调试？

答案：**每一步都记录**。包含：
- `index`：第几步（从 0 开始）
- `assistantText`：LLM 原始输出（用于调试）
- `parsed`：解析后的结构（用于判断做了什么）
- `observation`：工具执行结果（如果这步调了工具）
- `tokenUsage`：这步消耗了多少 token

> 这就像日志系统——循环结束后可以回看 "第 0 步做了什么，第 1 步做了什么……"

### 2.4 `TurnResult` — 一轮的最终交付物

```typescript
export type TurnStatus = 'ok' | 'error' | 'cancelled'

export type TurnResult = {
    finalText: string
    steps: AgentStepTrace[]
    status: TurnStatus
    errorMessage?: string
    tokenUsage?: Partial<TokenUsage>
}
```

**为什么需要这个？**

调用方（目前是 `index.ts` 的 REPL）需要知道：
- 最终回答是什么？(`finalText`)
- 过程中经历了什么？(`steps`)
- 成功了还是失败了？(`status`)
- 如果失败了，原因是什么？(`errorMessage`)
- 花了多少 token？(`tokenUsage`)

> **注意**：memo-code 的 `TurnStatus` 还有 `'prompt_limit'`（上下文爆了），
> 但我们 Phase 2 不做上下文压缩，所以先不加。**Phase 6 再补**。

### 2.5 `ExecuteTool` — 为 Phase 3 留的口子

```typescript
export type ExecuteTool = (
    toolName: string,
    toolInput: unknown,
) => Promise<string>
```

**这是一个关键设计决策：依赖注入。**

ReAct 循环需要执行工具，但 Phase 2 还没有真实工具。怎么办？

方案 A：在循环里写死 `if/else` 判断工具名 → ❌ 耦合太紧
方案 B：把工具执行抽成一个函数签名，由外部传入 → ✅ 这就是依赖注入

Phase 2 传入一个 mock：
```typescript
const defaultExecuteTool = async (toolName) => {
    return `[tool "${toolName}" not implemented yet]`
}
```

Phase 3 替换为真实的工具注册表查找。**循环代码一行不用改。**

---

## 第三部分：react-loop.ts — ReAct 引擎的核心

> 对应源码：[react-loop.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/runtime/react-loop.ts)

### 3.1 架构决策："为什么是纯函数而不是类方法？"

第一个设计决策：`runTurn()` 写成**纯函数**还是写成 **Session 类的方法**？

memo-code 把整个 ReAct 循环塞在 `AgentSessionImpl.runTurn()` 里（1237 行类中 ~700 行是这个方法）。
这导致循环逻辑和状态管理**紧耦合**——要测试循环必须构造整个 Session。

我们选择 **分离**：
```
react-loop.ts  → 纯函数 runTurn()，只接收数据参数
session.ts     → Session 类，只管状态，调用 runTurn()
```

好处：
- `runTurn()` 可以单独测试（传入 mock history 和 mock callLLM）
- Session 可以单独测试（验证历史管理、轮次计数）
- 后续 Phase 扩展时，两边独立变化

### 3.2 两个解析函数：从"原始格式"到"语义格式"

#### `normalizeLLMResponse()` — 拆包

```
LLMResponse.content: ContentBlock[]
     ↓ 拆解
textContent: string        ← 所有 TextBlock 拼起来
toolUseBlocks: [{id, name, input}]  ← 所有 ToolUseBlock 提取出来
```

**为什么需要这一步？**

`ContentBlock[]` 是 LLM 的原始返回格式：文本和工具调用混在一个数组里。
比如 LLM 可能返回：
```json
[
  { "type": "text", "text": "让我来读一下这个文件" },
  { "type": "tool_use", "id": "call_1", "name": "read_file", "input": {"path": "foo.ts"} }
]
```

normalize 之后变成两个清晰的变量：
- `textContent = "让我来读一下这个文件"`
- `toolUseBlocks = [{ id: "call_1", name: "read_file", input: {path: "foo.ts"} }]`

> 这是一个 **关注点分离** 的经典手法：底层返回混杂格式，上层先 normalize 再处理。

#### `parseLLMResponse()` — 语义判定

```
textContent + toolUseBlocks
     ↓ 语义判定
ParsedAssistant { action? / final? / thinking? }
```

判定逻辑非常简单，三行 if-else：

```typescript
if (toolUseBlocks.length > 0)  → action（取第一个工具），文本归入 thinking
else if (textContent.trim())   → final（这就是最终回答）
else                           → {}（空响应，循环将 break 退出）
```

**为什么只取第一个工具？** Phase 2 简化处理，不做并发工具调用。
Phase 4 的 ToolOrchestrator 会处理多工具并发场景。

### 3.3 `runTurn()` 主循环：逐行思路

我把循环拆成 6 个阶段来讲。对照源码阅读：

```
阶段 1: 准备  → 初始化变量，用户消息入历史
阶段 2: 调用  → callLLM(history)
阶段 3: 解析  → normalize → parse → 记录 step
阶段 4: 入历史 → 把 assistant 消息追加到 history
阶段 5: 分支  → action? → 执行工具 → continue
              → final?  → break
              → 其他?   → break（防死循环）
阶段 6: 返回  → 构建 TurnResult
```

#### 阶段 1: 准备

```typescript
const steps: AgentStepTrace[] = []
let finalText = ''
let status: TurnStatus = 'ok'
// ...
history.push({ role: 'user', content: input })
```

- `steps` 用于收集所有步骤的轨迹
- `status` 默认 `'ok'`，出错时改为 `'error'`
- 用户消息 **立刻** 追加到历史——这是 LLM 对话协议的要求

#### 阶段 2: 调用 LLM

```typescript
const llmResult = await callLLM(history)
```

注意：传入的是 **完整历史**，包括 system、之前的 user/assistant、以及刚追加的 user。
LLM 需要看到全部上下文才能做出正确决定。

如果调用失败（网络错误、API 限额等）：
```typescript
catch (err) {
    const msg = `LLM call failed: ${(err as Error).message}`
    history.push({ role: 'assistant', content: msg })
    status = 'error'
    break
}
```
直接 break，不再继续循环。

#### 阶段 4: assistant 消息入历史（关键细节！）

```typescript
if (toolUseBlocks.length > 0) {
    history.push({
        role: 'assistant',
        content: textContent,
        tool_calls: buildAssistantToolCalls(toolUseBlocks),
    })
} else if (textContent) {
    history.push({ role: 'assistant', content: textContent })
}
```

**为什么要区分两种情况？**

OpenAI 的对话协议有严格要求：
- 如果 assistant 消息包含 `tool_calls`，后面 **必须** 跟对应的 `tool` 消息
- `tool_calls` 的格式是 `[{ id, type: "function", function: { name, arguments } }]`

所以 `buildAssistantToolCalls()` 的作用就是把内部格式转回 OpenAI 协议格式：

```typescript
function buildAssistantToolCalls(blocks) {
    return blocks.map(b => ({
        id: b.id,
        type: 'function',
        function: {
            name: b.name,
            arguments: JSON.stringify(b.input),  // 必须是 JSON 字符串！
        }
    }))
}
```

> **这是一个容易踩的坑**：`arguments` 必须是 JSON **字符串**，不是对象。
> 因为 OpenAI API 返回的就是字符串，回传也要字符串。

#### 阶段 5: 分支判断

```
parsed.action 存在？
  ├── YES → 执行工具 → 结果追加为 tool 消息 → continue（回到循环顶部）
  ├── NO  → parsed.final 存在？
  │           ├── YES → finalText = parsed.final → break
  │           └── NO  → break（防死循环兜底）
```

工具执行后，结果必须作为 `tool` 消息追加到历史：
```typescript
history.push({
    role: 'tool',
    content: observation,
    tool_call_id: toolCallId,  // 必须对应 assistant.tool_calls[*].id
    name: toolName,
})
```

`tool_call_id` 是 **必填的**——它告诉 LLM "这是你第 N 个工具调用的结果"。
如果漏了或不匹配，API 会报错。

> **整个循环的核心洞察**：
> 对话历史就是 LLM 的"记忆"。每次循环我们都在往历史里追加消息（assistant → tool），
> 然后下一轮 LLM 调用会看到这些新消息，从而知道"工具返回了什么结果"。

---

## 第四部分：session.ts — 状态管理者

> 对应源码：[session.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/runtime/session.ts)

### 4.1 Session 的职责

Session 只做三件事：
1. **持有对话历史** — `history: ChatMessage[]`
2. **记录轮次** — `turnIndex`
3. **委托执行** — 调用 `react-loop.ts` 的 `runTurn()`

```typescript
class Session {
    readonly id: string
    readonly history: ChatMessage[] = []
    private turnIndex = 0
    private readonly callLLM: CallLLM

    async runTurn(input: string): Promise<TurnResult> {
        this.turnIndex += 1
        return runTurn(input, {
            history: this.history,  // 传引用，runTurn 会就地修改
            callLLM: this.callLLM,
        })
    }
}
```

### 4.2 为什么 history 传引用（就地修改）？

注意 `runTurn()` 接收的是 `this.history` 的 **引用**，不是副本。
这意味着 `runTurn()` 内部 `history.push(...)` 会直接修改 Session 的 history。

**为什么这样做？**

因为 history 是跨轮次共享的。第 1 轮的对话记录要保留到第 2 轮。
如果每次传副本，`runTurn()` 内部的修改就丢失了，Session 的 history 永远只有 system prompt。

> 这是一个 **有意的设计权衡**：传引用让修改自动同步，但也要清楚函数有副作用。
> 未来如果需要"只读"访问历史，用 `getHistory()` 返回副本。

### 4.3 为什么用 class 而不是纯函数？

Session 有 **状态**（history、turnIndex、id），这是 class 的天然适用场景。
对比 react-loop 的 `runTurn()` 是 **无状态** 的，所以用纯函数。

> **选择标准**：有内部状态要维护 → class；无状态纯计算 → 函数。

---

## 第五部分：index.ts — 把一切串起来

> 对应源码：[index.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/index.ts)

### 5.1 Phase 1 → Phase 2 的变化

Phase 1 的 index.ts：
```typescript
// 直接调用 callLLM，手动管理 history 数组
const response = await callLLM(history)
const text = response.content.filter(...).map(...).join('')
```

Phase 2 的 index.ts：
```typescript
// 创建 Session，由 Session 管理一切
const session = new Session({ callLLM, systemPrompt: '...' })
const result = await session.runTurn(input)  // TurnResult
console.log(result.finalText)
```

**关键变化**：
- 不再手动管理 `history` 数组
- 不再手动解析 `response.content`
- 通过 `TurnResult` 获取结构化的结果

### 5.2 完整的数据流

从用户输入到屏幕输出，数据经过了这些环节：

```
用户键入 "你好"
    ↓
index.ts: session.runTurn("你好")
    ↓
session.ts: 轮次 +1，调用 reactLoop.runTurn()
    ↓
react-loop.ts: history.push({role:'user', content:'你好'})
    ↓
react-loop.ts: callLLM(history)
    ↓
client.ts: OpenAI SDK → API 请求 → 返回 LLMResponse
    ↓
react-loop.ts: normalize → parse → ParsedAssistant{final:'你好！..'}
    ↓
react-loop.ts: history.push({role:'assistant', content:'你好！..'})
    ↓
react-loop.ts: return TurnResult{finalText, steps, status, tokenUsage}
    ↓
index.ts: console.log(result.finalText)
```

### 5.3 如果 LLM 请求了工具调用？（假设 Phase 3 已完成）

```
用户键入 "读一下 package.json"
    ↓
Step 0: LLM 返回 tool_use{name:'read_file', input:{path:'package.json'}}
    → parsed = { action: { tool:'read_file', input:{...} }, thinking:'让我读一下' }
    → 执行工具 → observation = "{ name: 'cclin', ... }"
    → history += assistant(tool_calls) → tool(result)
    → continue
    ↓
Step 1: LLM 看到工具结果 → 返回最终文本
    → parsed = { final: 'package.json 的内容是...' }
    → break
    ↓
TurnResult = {
    finalText: 'package.json 的内容是...',
    steps: [step0(action+observation), step1(final)],
    status: 'ok',
    tokenUsage: { prompt: 150, completion: 80, total: 230 }
}
```

---

## 第六部分：总结 — 你应该记住的核心概念

### 设计原则

| 原则 | 体现 |
|------|------|
| **关注点分离** | react-loop（逻辑）vs session（状态）vs index（入口） |
| **依赖注入** | `ExecuteTool` 类型 — Phase 2 mock，Phase 3 真实 |
| **层次解析** | `ContentBlock[]` → normalize → `ParsedAssistant` |
| **防御性编程** | LLM 调用 try/catch；空响应兜底 break |
| **协议合规** | `tool_call_id` 必须匹配；`arguments` 必须是 JSON 字符串 |

### 文件职责总结

```
types.ts        — 数据长什么样（类型定义）
react-loop.ts   — 循环怎么跑（纯逻辑）
session.ts      — 状态怎么存（Session 类）
index.ts        — 程序怎么启（入口 REPL）
llm/client.ts   — LLM 怎么调（SDK 封装，Phase 1 已有）
```

### 后续 Phase 会在哪里扩展？

- **Phase 3（工具系统）**：替换 `defaultExecuteTool` → 真实工具注册表
- **Phase 4（审批）**：在 `executeTool` 前插入审批检查
- **Phase 5（Prompt）**：Session 构造时组装动态 systemPrompt
- **Phase 6（压缩）**：在循环开始前检查 token 阈值
- **Phase 7（Hook）**：在循环关键节点发射事件

每个 Phase 都是在现有骨架上**插入**新逻辑，而不是推翻重来。
这就是为什么 Phase 2 的架构设计如此重要——它决定了后续所有 Phase 的扩展方式。

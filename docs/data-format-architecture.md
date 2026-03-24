# 数据格式转换的时机 — 一个容易被忽视的架构决策

> 从 cclin 项目中 `tool_calls` 格式转换的讨论出发，
> 展开探讨"数据在系统内部应该用什么形态流转"这一架构问题。

---

## 第一部分：这个问题是怎么来的？

### 1.1 起因：一个看似无关紧要的格式差异

在 cclin 的 `react-loop.ts` 中，存在**两套格式**来表示同一个东西——"LLM 请求调用的工具"：

**格式 A：内部流转格式**（在 `normalizeLLMResponse` 输出中）

```typescript
{ id: string; name: string; input: unknown }
```

**格式 B：OpenAI 协议格式**（在 `ChatMessage.tool_calls` 中）

```typescript
{
    id: string
    type: 'function'
    function: {
        name: string
        arguments: string  // JSON 字符串，不是对象！
    }
}
```

一个自然的问题浮上来：**为什么不在提取的时候就直接转成 OpenAI 格式？** 反正最终要写入 history 的时候都得转，何必多一个中间格式？

### 1.2 这个问题值得认真对待吗？

初看这只是"代码风格"问题——多一个函数少一个函数，似乎无所谓。

但如果你仔细想，它其实触及了一个核心的架构问题：

> **数据在系统内部的各个层次之间，应该以什么形态流转？**

这不是一个小问题。它决定了：
- 模块之间的耦合程度
- 代码在需求变化时的修改范围
- 新功能扩展的难度
- 调试和测试的便利性

接下来我们用 cclin 的具体代码来展开讲。

---

## 第二部分：cclin 里的数据流转全景

### 2.1 数据的一生：从 LLM 返回到写入 history

让我们追踪一个工具调用请求的完整旅程：

```
LLM API 返回 (ContentBlock[])
  │
  │  ┌──────────────────────────────────────────────┐
  │  │ { type: "tool_use",                          │
  │  │   id: "call_abc",                            │
  │  │   name: "read_file",                         │
  │  │   input: { path: "foo.ts" } }                │  ← 原始格式（Anthropic 风格）
  │  └──────────────────────────────────────────────┘
  ↓
normalizeLLMResponse() —— 拆包
  │
  │  ┌──────────────────────────────────────────────┐
  │  │ { id: "call_abc",                            │
  │  │   name: "read_file",                         │
  │  │   input: { path: "foo.ts" } }                │  ← 中间格式（cclin 内部）
  │  └──────────────────────────────────────────────┘
  │
  ├──→ parseLLMResponse()       用 name、input 做语义判定
  ├──→ executeTool()            直接把 input 对象传给工具函数
  ├──→ buildAssistantToolCalls()  转为 OpenAI 格式写入 history
  │
  │  ┌──────────────────────────────────────────────┐
  │  │ { id: "call_abc",                            │
  │  │   type: "function",                          │
  │  │   function: {                                │
  │  │     name: "read_file",                       │
  │  │     arguments: '{"path":"foo.ts"}' } }       │  ← 协议格式（OpenAI 风格）
  │  └──────────────────────────────────────────────┘
  ↓
写入 history → 下一轮发送给 LLM API
```

注意看**中间格式**被三个消费者使用，其中 `parseLLMResponse` 和 `executeTool` 都需要 `input` 是**对象**——如果提前 stringify 了，它们就得 parse 回来。

### 2.2 如果"提前转换"会怎样？

假设我们在 `normalizeLLMResponse` 里直接输出 OpenAI 格式：

```typescript
// ❌ 提前转换方案
function normalizeLLMResponse(response: LLMResponse) {
    const toolCalls = []
    for (const block of response.content) {
        if (block.type === 'tool_use') {
            toolCalls.push({
                id: block.id,
                type: 'function' as const,
                function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input), // 此刻就序列化
                },
            })
        }
    }
    return { textContent, toolCalls, ... }
}
```

后果是什么？

```typescript
// parseLLMResponse 要从 toolCalls 里拿 name 和 input
const name = toolCalls[0].function.name          // 还行，多一层访问
const input = JSON.parse(toolCalls[0].function.arguments) // 💥 多了一次反序列化

// executeTool 也要 parse
await executeTool(name, JSON.parse(arguments))   // 💥 又 parse 一次

// 写入 history —— 倒是省了 buildAssistantToolCalls
history.push({ role: 'assistant', tool_calls: toolCalls })  // ✅ 直接用
```

**省了一个函数，但多了两次 `JSON.parse`**。更重要的是，每个消费者都要知道"input 是 JSON 字符串，需要 parse"——这是**认知负担的扩散**。

---

## 第三部分：两个对立的设计原则

这个问题在软件架构中并不新鲜。它本质上是两种策略的取舍：

### 3.1 Early Normalization — "入口处统一"

> 数据进入系统的第一时间，就转成最终消费者需要的格式。
> 后续所有模块都用同一种格式，不再转换。

**类比**：国际机场入关时就要求所有人换成本国货币。

```
入口（API 返回） ──→ 立刻转为目标格式 ──→ 全系统统一使用
```

**优点**：
- ✅ 全局只有一种格式，降低认知负担
- ✅ 不需要记住"这一层用什么格式"
- ✅ 减少格式转换函数的数量

**缺点**：
- ❌ 如果目标格式有**信息损失**（如 stringify），内部消费者要反序列化
- ❌ 如果有多个"最终消费者"且格式不同，提前选定一种会得罪另一种
- ❌ 入口层和出口层**强耦合**——更换出口协议时要改入口代码

### 3.2 Late Serialization — "出口处转换"

> 系统内部用最自然、最富信息的形态流转。
> 只在数据离开系统（发给外部 API、写入数据库、返回给调用方）时才转换。

**类比**：在国内用当地语言交流，只在寄国际信时翻译成英文。

```
入口 ──→ 转为内部最优格式 ──→ 各模块使用 ──→ 出口处按需转为目标格式
```

**优点**：
- ✅ 内部模块拿到"最有用"的形态（对象 vs 字符串）
- ✅ 更换外部协议只改出口 adapter，不动核心逻辑
- ✅ 可以有多个不同格式的出口

**缺点**：
- ❌ 系统内可能同时出现多种格式，要清楚"哪一层用哪种"
- ❌ 多一个 adapter 层的代码

### 3.3 cclin 的选择

cclin 选择了 **Late Serialization**：

| 阶段 | 数据形态 | 原因 |
|------|---------|------|
| 入口（LLM 返回） | `ContentBlock[]` | API 给什么就接什么 |
| 内部流转 | `{ id, name, input }` | `input` 保持对象，方便消费 |
| 出口（写入 history） | `AssistantToolCall` | OpenAI 协议要求 JSON 字符串 |

**关键判断依据**：`input` 在内部有两个消费者（`parseLLMResponse`、`executeTool`），它们都需要对象形态。只有一个消费者（`history.push`）需要字符串形态。所以延迟序列化是**多数消费者友好**的选择。

---

## 第四部分：什么时候这个选择真正影响架构？

在 cclin 当前阶段（单一 LLM provider、单一输出格式），格式转换的时机影响不大——最多差一个函数。但随着系统复杂度增长，**这个选择会成为架构的分水岭**。

### 4.1 场景一：多 Provider 支持

假设将来 cclin 要同时支持 OpenAI 和 Anthropic API：

```
                 ┌── OpenAI API 返回
                 │   tool_calls: [{ id, type:"function", function:{name, arguments} }]
                 │
入口 adapter ────┤
                 │
                 └── Anthropic API 返回
                     content: [{ type:"tool_use", id, name, input }]
```

**如果用了 Early Normalization（且选 OpenAI 格式为标准）**：

- Anthropic adapter 里必须立刻 `JSON.stringify(input)` 来匹配 OpenAI 格式
- 所有内部代码都在操作 JSON 字符串
- 如果哪天需要对 `input` 做 schema 校验、参数过滤等操作，又要 parse 回来
- **入口层和 OpenAI 协议绑死**

**如果用了 Late Serialization**：

```typescript
// OpenAI adapter
function fromOpenAI(tc): InternalToolCall {
    return { id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments) }
}

// Anthropic adapter
function fromAnthropic(block): InternalToolCall {
    return { id: block.id, name: block.name, input: block.input }  // 天然就是对象
}

// 出口：按当前使用的 provider 格式化
function toOpenAI(tc): AssistantToolCall { ... }    // stringify
function toAnthropic(tc): ContentBlock { ... }      // 直接用
```

**核心逻辑（ReAct 循环）完全不用改。** 只增加 adapter。

### 4.2 场景二：工具参数校验 / 预处理

Phase 3 可能需要在执行工具前做参数校验：

```typescript
// 如果 input 是对象（Late Serialization）
function validateToolInput(schema: JSONSchema, input: unknown) {
    return ajv.validate(schema, input)  // ✅ 直接校验
}

// 如果 input 是 JSON 字符串（Early Normalization）
function validateToolInput(schema: JSONSchema, input: string) {
    const parsed = JSON.parse(input)     // 先 parse
    return ajv.validate(schema, parsed)  // 再校验
    // 校验完还要决定：传给 executeTool 是 parsed 还是原字符串？
}
```

对象形态让校验、转换、增强等中间操作**自然衔接**，不需要反复序列化。

### 4.3 场景三：数据持久化 / 日志

如果要把 `AgentStepTrace` 持久化到磁盘（Phase 8 的历史回放功能），两种策略的差异：

- **内部是对象** → 持久化时 `JSON.stringify(stepTrace)` 一次，读取时 `parse` 一次
- **内部就是字符串** → 持久化时字符串嵌套字符串，读取时要处理嵌套 parse（容易出 bug）

> **规律**：越是"中间会被多次加工"的数据，越适合用对象形态；越是"只透传不加工"的数据，提前转换也无妨。

---

## 第五部分：常见反模式

### 5.1 反模式一：格式透传（Passthrough Coupling）

> 内部函数直接操作外部 API 的数据结构，没有自己的中间表示。

```typescript
// ❌ 反模式：ReAct 循环直接操作 OpenAI 的 ChatCompletionMessageToolCall
function parseLLMResponse(toolCalls: ChatCompletionMessageToolCall[]) {
    const name = toolCalls[0].function.name
    const input = JSON.parse(toolCalls[0].function.arguments)
    // 每个函数都在和 OpenAI SDK 类型打交道
}
```

**问题**：如果更换 LLM SDK（比如从 `openai` 换成 `@anthropic-ai/sdk`），所有函数都要改。

**修复**：定义内部类型，让 adapter 负责翻译。

```typescript
// ✅ 内部类型
type InternalToolCall = { id: string; name: string; input: unknown }

// adapter 负责翻译
function fromOpenAIToolCalls(tcs: ChatCompletionMessageToolCall[]): InternalToolCall[] { ... }

// 内部函数只依赖 InternalToolCall
function parseLLMResponse(toolCalls: InternalToolCall[]) { ... }
```

### 5.2 反模式二：过度序列化（Serialize-Deserialize Sandwich）

> 数据被序列化为字符串后，下游立刻又反序列化回对象。

```typescript
// ❌ 反模式：serialize → 传递 → deserialize → 使用
const serialized = JSON.stringify(toolInput)    // 序列化
storeInHistory(serialized)                      // 传递
const deserialized = JSON.parse(serialized)     // 又反序列化
executeTool(toolName, deserialized)             // 使用
```

**问题**：无谓的 CPU 开销和 bug 风险（循环引用、特殊字符、数字精度丢失等）。

**修复**：只在真正需要时序列化。

```typescript
// ✅ 修复：只在写入 history 时序列化
executeTool(toolName, toolInput)                        // 直接用对象
storeInHistory({ arguments: JSON.stringify(toolInput) }) // 仅此处序列化
```

### 5.3 反模式三：格式选择焦虑（Format Bikeshedding）

> 花大量时间纠结中间格式该是什么样，最终选了一个既不像入口也不像出口的"第三种格式"。

**现实**：中间格式不需要"精心设计"。它只需要满足两个条件：
1. **信息完整**——不丢失任何下游可能需要的字段
2. **访问方便**——下游消费者能直接用，不需要额外转换

cclin 的 `{ id, name, input }` 就是个好例子——它几乎是 `ToolUseBlock` 去掉了 `type` 字段。足够简单，足够用。

---

## 第六部分：决策框架 — 什么时候用哪种？

遇到"该不该提前转换格式"的问题时，按以下流程判断：

### 6.1 决策树

```
这份数据在内部有多少个消费者？
│
├── 只有 1 个消费者（直接送往出口）
│   → 用 Early Normalization ✅
│   → 理由：没有中间使用，提前转换无害且减少代码
│
├── 有 2+ 个消费者
│   │
│   ├── 所有消费者都能接受目标格式？
│   │   → 用 Early Normalization ✅
│   │   → 理由：统一格式，减少心智负担
│   │
│   └── 部分消费者需要不同形态？
│       → 用 Late Serialization ✅
│       → 理由：保持最富信息形态，出口处转换
│
└── 不确定将来会有多少消费者
    → 用 Late Serialization ✅
    → 理由：保持灵活性，避免提前做出限制性决策
```

### 6.2 判断清单

在做每个格式转换决策时，问自己这几个问题：

| # | 问题 | 如果"是" |
|---|------|---------|
| 1 | 转换后是否有**信息损失**？（如 stringify） | → Late Serialization |
| 2 | 有多个出口且格式**不同**吗？ | → Late Serialization |
| 3 | 内部是否需要对数据做**加工**（校验/过滤/增强）？ | → Late Serialization |
| 4 | 数据只是**透传**，内部不需要理解其含义？ | → Early Normalization |
| 5 | 只有**一种**出口格式且不太可能变？ | → Early Normalization |

### 6.3 一句话原则

> **格式转换就像翻译——越靠近边界做越好，系统内部应该用"母语"。**

在 cclin 中：
- **"母语"** = `{ id, name, input }`（对象形态，方便内部消费）
- **"翻译"** = `buildAssistantToolCalls()`（出口处转为 OpenAI JSON 格式）
- **"边界"** = `history.push()`（数据离开内部、进入协议层）

---

## 第七部分：延伸 — 这个原则在哪里还会出现？

这不是一个孤立的问题。在 cclin 的后续开发中，你会反复遇到类似的决策：

| 场景 | 内部格式 | 出口格式 | 转换时机 |
|------|---------|---------|---------|
| tool_calls | `{ id, name, input }` | `AssistantToolCall` | 写入 history 时 |
| 工具定义 | 内部 `ToolDef` | OpenAI `ChatCompletionTool` | 调用 LLM 时 |
| System prompt | 结构化模板对象 | 字符串拼接 | callLLM 前 |
| 对话历史 | `ChatMessage[]` | API 特定格式 | adapter 层 |
| 步骤轨迹 | `AgentStepTrace` | JSON 文件 | 持久化时 |

每次都是同一个问题：**内部用什么形态最方便？在哪里转为外部需要的格式？**

记住这个思维模型，它会在你整个软件工程生涯中反复出现——不只是 Agent 开发，任何涉及**外部协议对接**的系统都适用。

---

> **本文核心**：数据格式转换的时机不是"代码风格"问题，而是影响耦合度、可扩展性和可维护性的**架构决策**。默认选择 Late Serialization（出口处转换），除非有明确理由提前。


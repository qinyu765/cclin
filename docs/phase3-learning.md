# Phase 3 学习笔记 — 工具系统

> 这份文档记录了 Phase 3 的每一步做了什么、为什么这样做、思考过程是怎样的。
> 目标：读完后你能**独立从零写出同样的代码**。

---

## 第一部分：宏观理解 — Phase 3 在干什么？

### 1.1 Phase 2 的现状

Phase 2 完成后，我们有了 ReAct 循环骨架：

```
src/
├── index.ts          ← readline REPL，通过 Session 驱动
├── types.ts          ← ChatMessage, LLMResponse, ParsedAssistant...
├── runtime/
│   ├── react-loop.ts ← Think → Act → Observe 循环
│   └── session.ts    ← 管理多轮会话历史
└── llm/
    └── client.ts     ← OpenAI SDK 封装
```

Phase 2 的 ReAct 循环能跑，但工具执行是个 **mock**：

```typescript
const defaultExecuteTool = async (toolName) => {
    return `[tool "${toolName}" not implemented yet]`
}
```

LLM 看不到任何工具描述，也无法真正调用工具。**Phase 3 的任务就是把这个 mock 换成真实的工具系统。**

### 1.2 Phase 3 要解决的三个问题

```
问题 1：怎么定义工具？（ToolDefinition 类型）
问题 2：怎么让 LLM 知道有哪些工具？（tools 参数 → function calling）
问题 3：怎么执行工具并返回结果？（ToolRegistry → ExecuteTool）
```

这三个问题的答案构成了整个 Phase 3 的架构。

### 1.3 思考过程：从参考项目学习，但不照搬

在开始写代码前，我先看了 memo-code 的工具系统架构：

```
memo-code 的工具系统（复杂版）：
├── tools/types.ts    — defineMcpTool() 工厂 + zod schema
├── router/types.ts   — Tool, NativeTool, McpTool 接口体系
├── router/native/    — NativeToolRegistry 类
├── approval/         — 完整的审批系统
└── tools/*.ts        — 具体工具实现
```

memo-code 用了 `zod` 来做输入校验，用了 MCP 协议格式，有复杂的路由和审批层。

**我的简化策略**：
- ❌ 不引入 zod（Phase 3 手写校验，保持零依赖）
- ❌ 不做 MCP 支持（那是 Phase 9）
- ❌ 不做审批流程（那是 Phase 4）
- ✅ 保留核心模式：`ToolDefinition` + `ToolRegistry` + `createExecuteTool()`

> **原则**：学习参考项目的 **设计模式**，但根据当前 Phase 的需求做 **精简**。

### 1.4 Phase 3 新增的文件

```
src/tools/
├── registry.ts       ← 工具注册表（连接定义和执行）
├── read-file.ts      ← 读取文件
├── write-file.ts     ← 写入文件
├── edit-file.ts      ← 字符串替换
├── bash.ts           ← 执行 Shell 命令
├── list-directory.ts ← 列出目录
└── safety.ts         ← 路径校验 + 命令分级
```

修改的文件：
- `types.ts` — 新增 `ToolDefinition`, `ToolResult`, `ToolInputSchema`
- `llm/client.ts` — `createCallLLM` 支持传入 `tools` 参数
- `index.ts` — 创建注册表、注册工具、传入 Session

---

## 第二部分：类型设计 — 工具长什么样？

### 2.1 思考起点："一个工具需要描述哪些信息？"

LLM 的 function calling 机制需要知道：
1. 工具叫什么（name）
2. 工具干什么（description）
3. 工具接受什么参数（parameters / inputSchema）

执行侧还需要知道：
4. 怎么执行这个工具（execute 函数）
5. 这个工具是否会修改外部状态（isMutating）

这 5 个信息组合起来，就是 `ToolDefinition`：

```typescript
export type ToolDefinition = {
    name: string
    description: string
    inputSchema: ToolInputSchema
    isMutating: boolean
    execute: (input: Record<string, unknown>) => Promise<ToolResult>
}
```

### 2.2 `ToolInputSchema` — 为什么不直接用 JSON Schema？

```typescript
export type ToolInputSchema = {
    type: 'object'
    properties: Record<string, {
        type: string
        description?: string
        items?: { type: string }
        enum?: string[]
        default?: unknown
    }>
    required?: string[]
}
```

OpenAI 的 function calling 需要 JSON Schema 格式的参数描述。完整的 JSON Schema 支持
数十种关键字（`allOf`, `oneOf`, `$ref` 等），但 **Agent 的工具参数通常很简单**：
几个字符串、数字、布尔值。

所以我定义了一个 **JSON Schema 子集**：只保留最常用的字段。好处是：
- 类型更严格（不是 `Record<string, unknown>`，而是具体字段）
- IDE 有补全提示
- 后续如果需要更复杂的 schema，再扩展

> **对比 memo-code**：它用 zod 的 `.toJSONSchema()` 自动生成，更灵活但也更重。
> 我们选择手写 schema，因为 Phase 3 只有 5 个工具，手写完全可控。

### 2.3 `ToolResult` — 为什么不直接返回字符串？

```typescript
export type ToolResult = {
    output: string
    isError?: boolean
}
```

Phase 2 的 `ExecuteTool` 签名返回 `string`。为什么 `ToolDefinition.execute` 返回 `ToolResult`？

因为 **工具需要区分"成功输出"和"错误输出"**。比如：
- `read_file` 成功 → `{ output: "文件内容..." }`
- `read_file` 文件不存在 → `{ output: "File not found", isError: true }`

两种情况都返回文字，但语义不同。`isError` 让上游（Phase 4 审批、Phase 7 Hook）
可以区分处理。

> **注意**：目前 `ToolRegistry.createExecuteTool()` 会把 `ToolResult.output` 
> 拉平为纯字符串，因为 ReAct 循环的 `ExecuteTool` 接口只返回 `string`。
> 这是一个 **有意的分层**：工具层保留丰富信息，循环层简化接口。

---

## 第三部分：ToolRegistry — 连接一切的枢纽

> 对应源码：[registry.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/tools/registry.ts)

### 3.1 思考起点："工具定义好了，怎么让各部分用起来？"

工具系统需要服务两个方向：

```
方向 1: ToolDefinition → LLM
    LLM 需要知道有哪些工具、参数是什么 → toOpenAITools()

方向 2: ToolDefinition → ReAct 循环
    循环需要根据工具名执行工具 → createExecuteTool()
```

`ToolRegistry` 就是这个双向转换器：

```
                     ┌──────────────────┐
    ToolDefinition ──►  ToolRegistry    ├──► toOpenAITools()    → 给 LLM
                     │  (Map<name, def>)├──► createExecuteTool() → 给循环
                     └──────────────────┘
```

### 3.2 `toOpenAITools()` — 从我们的格式到 OpenAI 格式

```typescript
toOpenAITools() {
    return this.getAll().map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
        },
    }))
}
```

OpenAI 的 function calling 需要这个格式：
```json
{
  "type": "function",
  "function": {
    "name": "read_file",
    "description": "Read the contents of a file...",
    "parameters": { "type": "object", "properties": {...}, "required": [...] }
  }
}
```

注意：我们的 `inputSchema` 恰好就是 JSON Schema 格式，所以直接放到 `parameters` 字段里。

### 3.3 `createExecuteTool()` — 闭包的经典用法

```typescript
createExecuteTool(): ExecuteTool {
    return async (toolName, toolInput) => {
        const tool = this.get(toolName)       // 在注册表里查找
        if (!tool) return `Error: tool "${toolName}" not found.`

        const input = (toolInput ?? {}) as Record<string, unknown>
        const result = await tool.execute(input)
        return result.output                  // ToolResult → string
    }
}
```

**为什么返回一个函数？**

因为 `ExecuteTool` 的签名是 `(name, input) => Promise<string>`，
而 ToolRegistry 的 `get()` 方法需要 `this` 引用。

用闭包把 `this`（即 registry 实例）**捕获**到返回的函数里，
这样调用方（Session、ReAct 循环）只需要一个简单的函数引用，
不需要知道 ToolRegistry 的存在。

> **这就是 Phase 2 留下的依赖注入接口 `ExecuteTool` 发挥作用的地方。**
> 循环代码 **一行都不用改**，只是注入的函数从 mock 变成了真实实现。

---

## 第四部分：工具实现 — 每个工具怎么写？

### 4.1 所有工具共享的模式

每个工具的 `execute` 函数都遵循同一个四步模式：

```
Step 1: 验证输入  — 必填参数检查
Step 2: 路径校验  — validatePath() 防穿越 + 防敏感文件
Step 3: 执行操作  — fs.readFile / fs.writeFile / execSync
Step 4: 格式化输出 — 构建人类可读的结果字符串
```

**为什么要统一模式？** 因为 LLM 的输入是 `unknown`（来自 JSON 解析），
必须防御性地处理。每个工具的开头长得很像，这是 **有意的重复**。

### 4.2 详解 `read_file` — 最典型的工具

> 对应源码：[read-file.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/tools/read-file.ts)

```typescript
async execute(input) {
    // Step 1: 验证输入
    const filePath = String(input.path ?? '')
    if (!filePath) return { output: '...', isError: true }

    // Step 2: 路径校验
    const validation = validatePath(filePath)
    if (!validation.ok) return { output: validation.error, isError: true }

    // Step 3: 执行操作
    const resolved = path.resolve(filePath)
    const raw = await fs.readFile(resolved, 'utf-8')

    // Step 4: 格式化输出（带行号）
    const lines = raw.split('\n')
    const numbered = lines.map((line, i) => `${i + 1}: ${line}`).join('\n')
    return { output: `File: ${resolved}\n${numbered}` }
}
```

**几个关键细节：**

1. **`String(input.path ?? '')`** — 防御 `undefined` 和非字符串输入。
   LLM 生成的 JSON 可能缺少字段或类型不对。
   
2. **`path.resolve(filePath)`** — 将相对路径转为绝对路径，
   让输出信息明确告诉 LLM "我读的是哪个文件"。

3. **带行号输出** — `1: const x = 1` 格式让 LLM 后续使用 `edit_file` 时
   能精确定位要修改的行。

4. **`offset/limit` 分段读取** — 大文件场景下，Agent 可以只读前 50 行，
   而不是把 10000 行全塞进上下文。

### 4.3 其他工具的特殊考量

#### `edit_file` — 为什么要检查多匹配？

```typescript
const secondIdx = original.indexOf(oldText, idx + 1)
if (secondIdx !== -1) {
    return { output: 'Error: old_text matches multiple locations.', isError: true }
}
```

如果 `old_text` 在文件中出现多次，直接替换会 **只改第一个**，
但 LLM 可能期望改的是第二个。与其猜错，不如报错让 LLM 提供更精确的文本。

#### `bash` — 命令安全分级

```typescript
const safety = classifyCommand(command)
if (safety === 'block') return { output: 'Blocked: ...' }
if (safety === 'confirm') console.log('⚠️ confirm-level command')
// safe → 直接执行
```

三级分类：
- **block**：绝对危险（`rm -rf /`, `mkfs`, fork bomb）→ 直接拒绝
- **confirm**：有风险（`rm`, `mv`, `kill`）→ Phase 3 放行，Phase 4 加审批
- **safe**：安全命令 → 直接执行

#### `list_directory` — 为什么要显示文件大小？

```
  [DIR]  src/
  [FILE] package.json (575 B)
  [FILE] pnpm-lock.yaml (502.7 KB)
```

文件大小帮助 LLM 判断是否值得读取整个文件。
500KB 的 lock 文件显然不该全部读进上下文。

---

## 第五部分：集成 — 怎么把一切串起来？

### 5.1 思考起点："哪些文件需要修改？"

工具系统写好了，但还 **没有接入**。需要回答三个问题：

```
Q1: LLM 怎么知道有工具？ → client.ts 要传 tools 参数
Q2: 循环怎么执行真实工具？ → session.ts 要传 executeTool
Q3: 谁来创建注册表？ → index.ts 组装一切
```

### 5.2 `client.ts` 的改动 — 只加了一个字段

> 对应源码：[client.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/llm/client.ts)

```typescript
// 改前：
const data = await client.chat.completions.create({
    model: config.model,
    messages: openAIMessages,
})

// 改后：
const data = await client.chat.completions.create({
    model: config.model,
    messages: openAIMessages,
    ...(config.tools?.length ? { tools: config.tools } : {}),
})
```

**关键设计**：用扩展运算符 `...` 有条件地添加 `tools`。
如果没有工具（比如 Phase 2 的测试场景），就不传 `tools` 字段，
API 行为和以前完全一样。**向后兼容**。

### 5.3 `index.ts` 的改动 — 组装的艺术

> 对应源码：[index.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/index.ts)

Phase 2 的 index.ts：
```typescript
const callLLM = createCallLLM({ apiKey, baseURL, model })
const session = new Session({ callLLM, systemPrompt: '...' })
```

Phase 3 的 index.ts：
```typescript
// 1. 创建注册表，注册所有工具
const registry = new ToolRegistry()
registry.registerMany([readFileTool, writeFileTool, editFileTool, bashTool, listDirectoryTool])

// 2. 创建 LLM 调用函数，带工具描述
const callLLM = createCallLLM({
    apiKey, baseURL, model,
    tools: registry.toOpenAITools(),   // ← 工具描述给 LLM
})

// 3. 创建 Session，带真实工具执行
const session = new Session({
    callLLM,
    systemPrompt: '...',
    executeTool: registry.createExecuteTool(),  // ← 工具执行给循环
})
```

**注意 registry 的两个产出物分别流向不同的地方：**

```
registry.toOpenAITools()    → config.tools → LLM API 请求
registry.createExecuteTool() → session.executeTool → ReAct 循环
```

这就是 ToolRegistry 作为"枢纽"的价值——
它向上翻译给 LLM，向下翻译给循环，两边互不知道对方的存在。

### 5.4 安全机制在数据流中的位置

```
用户输入 → LLM → 决定调用 bash("rm -rf /") →
    → react-loop 调用 executeTool("bash", {...}) →
        → ToolRegistry 查找 bashTool →
            → bashTool.execute() →
                → classifyCommand("rm -rf /") → "block" →
                    → 返回 "Blocked: dangerous command" →
                        → ReAct 循环把结果反馈给 LLM
```

安全检查发生在 **工具内部**，不需要循环层知道。
每个工具自己负责安全——这符合"能力越大，责任越大"的原则。

### 5.5 为什么 `react-loop.ts` 和 `session.ts` 不用改？

这是 Phase 2 依赖注入设计的回报。循环代码只认 `ExecuteTool` 接口：

```typescript
observation = await executeTool(toolName, toolInput)
```

它不关心背后是 mock、ToolRegistry、还是远程 MCP Server。
只要传入的函数满足签名 `(string, unknown) => Promise<string>`，循环就能跑。

> **设计洞察**：好的接口设计让模块独立演化。
> Phase 2 定义了 `ExecuteTool` 接口，Phase 3 实现了它，Phase 9 还能替换为 MCP 路由。
> 循环代码自始至终不用改。

---

## 第六部分：总结 — 你应该记住的核心概念

### 设计原则

| 原则 | 体现 |
|------|------|
| **统一接口** | `ToolDefinition` 让所有工具有相同的形状（name, schema, execute） |
| **适配器模式** | `ToolRegistry` 双向转换：→ OpenAI 格式 / → ExecuteTool签名 |
| **依赖注入回报** | Phase 2 的 `ExecuteTool` 接口在 Phase 3 零改动接入真实工具 |
| **分层安全** | 安全检查在工具内部，循环层不关心安全逻辑 |
| **防御性编程** | 所有输入用 `String(x ?? '')` 防空值；路径用 `validate` 防穿越 |
| **向后兼容** | `config.tools` 可选，不传时 client.ts 行为不变 |

### 文件职责总结

```
types.ts           — 工具长什么样（ToolDefinition, ToolResult, ToolInputSchema）
tools/registry.ts  — 工具怎么管（注册、查询、格式转换）
tools/safety.ts    — 什么是安全的（路径校验、命令分级、敏感文件）
tools/read-file.ts — 读文件（支持 offset/limit 分段）
tools/write-file.ts — 写文件（自动创建目录）
tools/edit-file.ts  — 改文件（精确字符串替换）
tools/bash.ts       — 跑命令（安全分级 + 超时控制）
tools/list-directory.ts — 看目录（类型 + 大小）
llm/client.ts      — LLM 调用（新增 tools 参数透传）
index.ts           — 组装一切（注册表 → LLM + Session）
```

### 完整数据流（带工具调用）

```
用户键入 "帮我列出当前目录的文件"
    ↓
index.ts: session.runTurn("帮我列出当前目录的文件")
    ↓
session.ts: 轮次 +1，调用 reactLoop.runTurn()
    ↓
react-loop.ts: history.push({role:'user', content:'帮我列出...'})
    ↓
react-loop.ts: callLLM(history)
    ↓
client.ts: OpenAI SDK → API 请求（带 tools 参数）
    ↓
API 返回: tool_use { name: 'list_directory', input: { path: '.' } }
    ↓
react-loop.ts: normalize → parse → action: { tool: 'list_directory', input: {path:'.'} }
    ↓
react-loop.ts: executeTool('list_directory', {path:'.'})
    ↓
registry.ts: createExecuteTool() → 查找 listDirectoryTool → 执行
    ↓
list-directory.ts: validatePath('.') → fs.readdir('.') → 格式化输出
    ↓
react-loop.ts: observation = "[DIR] src/\n[FILE] package.json (575 B)\n..."
    ↓
react-loop.ts: history.push({role:'tool', content: observation})
    ↓
react-loop.ts: callLLM(history)  ← LLM 看到工具结果
    ↓
API 返回: text "当前目录包含以下文件..."
    ↓
react-loop.ts: parsed.final → break
    ↓
index.ts: console.log("当前目录包含以下文件...")
```

### 后续 Phase 会怎么扩展？

- **Phase 4（审批）**：在 `createExecuteTool()` 返回的函数里，
  执行工具前插入审批检查。`isMutating` 字段此时发挥作用。
- **Phase 5（Prompt）**：`toOpenAITools()` 的输出会被注入到系统提示词中，
  让 LLM 更好地理解工具能力。
- **Phase 7（Hook）**：在工具执行前后发射 `onAction` / `onObservation` Hook。
- **Phase 9（MCP）**：`createExecuteTool()` 升级为路由器，
  先查 native 工具，再查 MCP 工具。

每个 Phase 都是在现有骨架上**插入**新逻辑，而不是推翻重来。
Phase 2 定义了循环接口，Phase 3 定义了工具接口——
**这两层接口是整个 Agent 的稳定骨架**。

---

## 附录：端到端测试中发现的三个 Bug

> Phase 3 代码写完后，我们运行了 `pnpm dev` 做端到端测试。
> 以下是真实对话中暴露的问题和修复过程。
> **这些 bug 证明了"写完代码不等于完成"，真正的学习来自实际运行。**

### Bug 1: 多工具调用时 API 报 400 错误

**现象**：输入 "评价一下这个项目"，LLM 一次返回 3 个 tool_call，
第一个执行成功，但 API 响应报 `400 No tool output found for function call`。

**根因**：Phase 2 的循环 **只执行第一个** 工具调用，
只发送 1 条 `tool` 消息。但 OpenAI API 要求 **每个 `tool_call` 都必须
有对应的 `tool` 消息**，漏掉的就 400。

**修复**：将单工具执行改为遍历所有 `toolUseBlocks`：

```typescript
// 修复前：只执行第一个
observation = await executeTool(toolName, toolInput)
history.push({ role: 'tool', content: observation, tool_call_id: ... })

// 修复后：遍历所有
for (const block of toolUseBlocks) {
    const observation = await executeTool(block.name, block.input)
    history.push({ role: 'tool', content: observation, tool_call_id: block.id, name: block.name })
}
```

**思考延伸**：这个 bug 在 Phase 2 不会出现（因为没传 tools 参数，LLM 不会产生
tool_calls）。它只在 Phase 3 真正启用 function calling 后才暴露。
**所以端到端测试是不可替代的。**

### Bug 2: 工具调用计数不准

**现象**：日志显示执行了 22 次工具调用，但摘要显示 `[tool calls: 5]`。

**根因**：`index.ts` 统计的是"有工具调用的 step 数"，而不是"实际调用次数"。
一个 step 里可能并行调用 5 个工具，但只计 1。

**修复**：在 `AgentStepTrace` 中新增 `toolCallCount` 字段，
`index.ts` 用 `reduce` 累加所有 step 的实际调用数。

### Bug 3: 循环没有最大步骤限制

**现象**（潜在风险）：`for (let step = 0; ; step++)` 是无限循环。
如果 LLM 持续返回工具调用（比如不断读文件），进程永远不会停。

**修复**：添加 `MAX_STEPS = 25` 上限，超过后返回错误提示。

```typescript
// 修复后
const MAX_STEPS = 25
for (let step = 0; step < MAX_STEPS; step++) { ... }

// 循环后的兜底
if (!finalText && status === 'ok') {
    status = 'error'
    finalText = 'I reached the maximum number of steps.'
}
```

### Bug 的共同教训

| 特征 | 说明 |
|------|------|
| **都是集成级别的 bug** | 单个文件看没问题，组装起来才出问题 |
| **都和"多"有关** | 多工具、多 step、多计数 |
| **都需要真实环境才能发现** | TypeScript 类型检查通过 ≠ 运行正确 |

> **核心启示**：typecheck 只验证"形状对不对"，端到端测试验证"行为对不对"。
> 两者缺一不可。

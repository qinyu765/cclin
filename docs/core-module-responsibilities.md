# cclin 核心模块职责划分与架构解析

> 详解 client.ts、react-loop.ts、session.ts 和 index.ts 的设计边界与职责。

## 模块职责速览

在构建 cclin 这样的 CLI Agent 框架时，各个模块扮演着明确的角色：

- `react-loop.ts`：实现 Think → Act → Observe 循环的**核心引擎**。
- `session.ts`：管理多轮对话状态的**状态容器**，能调用 ReAct 循环。
- `client.ts`：内部类型系统和 OpenAI SDK 之间的**适配器/翻译层**。
- `index.ts`：将各组件组装起来的**组装者**与**交互（REPL）壳**。

## 详细架构拆解

### 1. index.ts（组装者 + REPL 壳）
它处于最外层，实际与用户终端接触。
- 组装依赖：创建 `callLLM`、注册工具、创建 `Session`。
- readline 循环：读取用户输入 → 调用 `session.runTurn()` → 打印结果。
- **不涉及**任何 LLM 请求的具体细节或工具执行细节。

### 2. session.ts（状态容器）
作为一个类，管理发起请求用到的状态：
- 持有 `history`（对话历史）、`turnIndex`（轮次计数）、`callLLM`、`executeTool`。
- 提供 `runTurn()` 方法，实际将执行委托给 `react-loop.ts` 。
- **不包含**循环逻辑，只负责维护一次会话的上下文，使其易于测试和扩展（比如持久化存储）。

### 3. react-loop.ts（核心引擎）
它实现了观察、思考、行动的 ReAct 循环：
- 接收 `session.ts` 传来的输入和依赖。
- 调用 `callLLM()` 驱动 LLM 思考生成下一步。
- 根据 LLM 返回，决定调用 `executeTool()` 执行工具，还是结束当前循环并返回最终回答。
- 最终返回 `TurnResult` 给外部状态容器。

### 4. client.ts（适配器）
用于与底层 LLM API SDK (如 OpenAI) 交互，作为中间层隔离第三方依赖。具体来说，它是格式转换适配器（双向）：
- **请求方向（发出去）**：`toOpenAIMessage()` 把项目内部的 `ChatMessage` 格式转成 OpenAI SDK 要求的数据结构。
- **响应方向（收回来）**：将 OpenAI SDK 返回的原始响应解析成项目内部的标准化 `LLMResponse` 格式（如提取 `reasoning_content`、解析并验证工具参数、转换为 `ContentBlock[]` 数组）。
- **封装 API 调用**：真正执行网络请求（如 `client.chat.completions.create(...)`）的地方。

## 为什么需要明确这些模块边界？

这是贯彻**关注点分离（Separation of Concerns）**核心架构原则的体现。清晰职责边界带来的实际好处：

### 1. 知道改哪里
当增加新功能或修复问题时，能立刻定位到准确的文件：
- 换一个 LLM 提供商 → `client.ts`
- 修改工具执行逻辑 / 添加新工具 → `tools/` 目录相关文件
- 调整 Agent 循环策略（比如重试机制、最大限制步数） → `react-loop.ts`
- 增加控制台命令（如 `/clear` 命令清空历史） → `index.ts`
- 为对话添加数据库持久化存储 → `session.ts`

### 2. 知道不该改哪里
比如，当需要增加“网络请求失败重试”功能时，如果错误理解成是入口负责发请求，可能会将重试逻辑加到 `index.ts` 中，导致代码耦合。正确的做法是将其加在底层服务层 `client.ts` 或引擎层 `react-loop.ts` 中。

### 3. 为未来的演进打好基础
在后续的进阶阶段（例如：支持终端流式输出打印进度、构建图形化 Web UI 替换终端控制台、开发多 Agent 协作系统）时，清晰的边界能保证你可以替换掉外壳（`index.ts`）而完全保留引擎逻辑，或者替换 LLM SDK（`client.ts`）而不用修改循环机制，防止由于业务逻辑膨胀导致架构崩塌。

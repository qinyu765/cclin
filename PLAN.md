# CCLIN — 开发计划

> 编写参考`D:\For coding\project\Agents\example\memo-code`,但不要完全照搬
> 从零构建一个生产级 CLI Code Agent，对标 memo-code 架构。
> 技术栈：Node.js + TypeScript + OpenAI SDK + Ink (TUI)

---

## 开发路线图

按先后顺序排列，每个 Phase 都产出可运行的中间产物。

### Phase 1: 项目基础 & LLM 集成 ✅
**目标**：能成功调用 LLM 并打印响应。

- [x] 初始化项目（package.json / tsconfig.json / .env）
- [x] 安装核心依赖：`openai`, `typescript`, `tsx`, `dotenv`
- [x] 定义基础类型：`ChatMessage`, `LLMResponse`, `TokenUsage`
- [x] 封装 `callLLM()` 函数（支持依赖注入，方便后续替换/测试）
- [x] 编写简单入口验证 LLM 调用

**产出**：`bun run dev` 输入问题 → 拿到 LLM 纯文本回答。

---

### Phase 2: 手写 ReAct 循环 ✅
**目标**：脱离 SDK 自动循环，自己实现 Think → Act → Observe。

- [x] 定义 `ParsedAssistant` 类型（解析 LLM 响应中的工具调用）
- [x] 定义 `AgentStepTrace`（单步调试记录）
- [x] 实现 `runTurn(input)`：while 循环，直到 LLM 不再请求工具
- [x] `Session` 类管理多轮会话历史
- [x] 基础 readline REPL 作为临时入口

**产出**：输入任务 → Agent 循环调用工具 → 输出最终结果。

---

### Phase 3: 工具系统 ✅
**目标**：有可用的文件/命令工具，能完成基本编程任务。

- [x] 工具类型定义（`ToolDefinition` + `ToolRegistry`）
- [x] 工具注册机制
- [x] 实现 5 个基础工具：
  - [x] `read_file` — 读取文件（支持 offset/limit 分段）
  - [x] `write_file` — 写入/创建文件
  - [x] `edit_file` — 字符串替换
  - [x] `bash` — 执行 Shell 命令
  - [x] `list_directory` — 列出目录内容
- [x] 安全机制：
  - [x] 危险命令检测（block / confirm / safe 三级）
  - [x] 路径穿越防护
  - [x] 敏感文件检测

**产出**：Agent 能读写文件、执行命令，危险操作会暂停等确认。

---

### Phase 4: 审批 & 工具编排 ✅
**目标**：为工具执行加上权限控制和统一调度。

- [x] `ApprovalManager`：管理工具审批策略（always / once / session）
- [x] `ToolOrchestrator`：
  - 接收工具调用 → 审批 → 执行 → 错误分类 → 结果截断
  - 处理工具输入解析和大小限制
- [x] 将审批请求暴露为回调（为后续 Hook 化做准备）

**产出**：工具执行有统一入口，支持审批策略。

---

### Phase 5: Prompt 管理 ✅
**目标**：灵活的系统提示词组装。

- [x] 模板引擎：`{{date}}`, `{{user}}`, `{{pwd}}` 等变量替换
- [x] `prompt.md` 系统提示词模板（参考 memo-code 但精简）
- [x] 项目级 `AGENTS.md` 自动加载
- [x] 用户级 `SOUL.md` 加载（用户人格偏好）
- [x] 工具描述动态注入

**产出**：系统提示词可根据上下文动态组装。

---

### Phase 6: 上下文压缩 ✅
**目标**：长对话不会爆上下文窗口。

- [x] `TokenCounter`：本地 token 计数器（gpt-tokenizer）
- [x] 自动压缩阈值检测（可配置 context window 和百分比）
- [x] LLM 驱动的历史压缩（生成结构化摘要）
- [x] 压缩后 history 重建
- [x] 支持手动压缩（`/compact` 命令）

**产出**：长对话自动压缩，不丢失关键上下文。

---

### Phase 7: Hook / 中间件系统 ✅
**目标**：核心逻辑与 UI/日志解耦。

- [x] 定义 9 种生命周期 Hook：
  `onTurnStart` / `onAction` / `onObservation` / `onFinal` /
  `onContextUsage` / `onContextCompacted` /
  `onApprovalRequest` / `onApprovalResponse` / `onTitleGenerated`
- [x] `HookRunnerMap`：Hook 注册表
- [x] `registerMiddleware()`：批量注册中间件
- [x] `runHook()`：安全执行 Hook（单个失败不影响主流程）
- [x] 改造 ReAct 循环，在每个关键节点发射 Hook

**产出**：核心逻辑可通过 Hook 扩展，无需修改 session_runtime。

---

### Phase 8: TUI（Ink）
**目标**：美观的终端界面。

- 安装 Ink + ink-text-input 等
- 主 App 组件（输入框 + 输出区）
- 工具调用实时展示（spinner + 工具名 + 参数预览）
- 审批交互 UI（y/n 确认）
- 上下文使用量指示
- Markdown 渲染（可选，ink-markdown）

**产出**：从 readline 升级为美观的终端 UI。

---

### Phase 9: 工具路由 & MCP
**目标**：支持外部 MCP 工具，统一工具管理。

- `NativeToolRegistry`：内置工具管理
- `McpToolRegistry`：MCP Server 连接和工具发现
- `ToolRouter`：统一路由（优先 native，fallback mcp）
- MCP 配置加载（`mcp_config.json`）
- 工具描述自动生成（分 Native / MCP 两组注入 prompt）

**产出**：可通过配置文件接入任意 MCP Server 的工具。

---

### Phase 10: 高级功能（长期）
**目标**：对齐 memo-code 完整能力。

- 多 Agent 协作（`spawn_agent` / `send_input` / `wait` / `close_agent`）
- Skills 系统（技能发现 + prompt 注入）
- `get_memory` / `update_plan` 工具
- 会话持久化（JSONL 日志 / 历史回放）
- Model Profile（不同模型的参数配置）

---

## 验证策略

每个 Phase 完成后：
1. **手动测试**：在终端中运行，执行代表性任务
2. **单元测试**（Phase 3+）：对工具函数和解析器写测试
3. **集成测试**（Phase 7+）：模拟完整 Turn 循环

---

## 文件结构预览（最终形态）

```
cclin/
├── .agents/workflows/dev.md    # 开发协作 workflow
├── .env                        # API Key 配置
├── PLAN.md                     # 本文件
├── AGENTS.md                   # 项目级 Agent 指令
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                # 入口
    ├── types.ts                # 共享类型
    ├── llm/
    │   └── client.ts           # OpenAI SDK 封装
    ├── runtime/
    │   ├── session.ts          # AgentSession 类
    │   ├── react-loop.ts       # ReAct 循环
    │   ├── prompt.ts           # Prompt 组装
    │   ├── prompt.md           # 系统提示词模板
    │   ├── compaction.ts       # 上下文压缩
    │   └── hooks.ts            # Hook 系统
    ├── tools/
    │   ├── registry.ts         # 工具注册表
    │   ├── orchestrator.ts     # 工具编排器
    │   ├── approval.ts         # 审批管理器
    │   ├── router.ts           # 工具路由（Phase 9）
    │   ├── read-file.ts
    │   ├── write-file.ts
    │   ├── edit-file.ts
    │   ├── bash.ts
    │   └── list-directory.ts
    ├── tui/                    # Ink TUI（Phase 8）
    │   ├── app.tsx
    │   ├── input.tsx
    │   └── output.tsx
    └── utils/
        ├── safety.ts           # 安全检查
        └── tokenizer.ts        # Token 计数
```

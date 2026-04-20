# CCLIN — 开发计划

> 编写参考`D:\For coding\project\Agents\example\memo-code`,但不要完全照搬
> 从零构建一个生产级 CLI Code Agent，对标 memo-code 架构。
> 技术栈：Node.js + TypeScript + OpenAI SDK + Ink (TUI)

---

## 开发路线图

按先后顺序排列，每个 Phase 都产出可运行的中间产物。

### Phase 1: 项目基础 & LLM 集成 ✅
**目标**：能成功调用 LLM 并打印响应。

- [x] 初始化项目（package.json / tsconfig.json）
- [x] 安装核心依赖：`openai`, `typescript`, `tsx`, `smol-toml`
- [x] 定义基础类型：`ChatMessage`, `LLMResponse`, `TokenUsage`
- [x] 封装 `callLLM()` 函数（支持依赖注入，方便后续替换/测试）
- [x] 编写简单入口验证 LLM 调用

**产出**：`pnpm run dev` 输入问题 → 拿到 LLM 纯文本回答。

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

### Phase 8: TUI（Ink）✅
**目标**：美观的终端界面。

- [x] 安装 Ink + React + ink-text-input
- [x] 主 App 组件（输入框 + 输出区 + 标题栏）
- [x] 工具调用实时展示（状态图标 + 工具名 + 结果预览）
- [x] 审批交互 UI（y/n 按键确认）
- [x] 上下文使用量指示
- [x] Hook 驱动 TUI 状态（tuiMiddleware 替代 loggerMiddleware）

**产出**：从 readline 升级为基于 Ink 的终端 UI。

---

### Phase 9: 工具路由 & MCP ✅
**目标**：支持外部 MCP 工具，统一工具管理。

- [x] `ToolRouter`：统一路由（优先 native，fallback mcp）
- [x] `McpToolRegistry`：MCP Server 连接和工具发现
- [x] `McpClientPool`：MCP 连接池管理（stdio 传输）
- [x] MCP 配置加载（`mcp_config.json`）
- [x] 工具描述自动生成（分 Native / MCP 两组注入 prompt）
- [x] `ToolOrchestrator` 改用 `ToolQueryable` 接口

**产出**：可通过配置文件接入任意 MCP Server 的工具。

---

### Phase 10: 高级功能（长期）
**目标**：对齐 memo-code 完整能力。

- [x] 多 Agent 协作（方案一：`spawn_agent` 阻塞式；方案二：`spawn_agent_async` / `send_input` / `wait_agent` / `close_agent` 异步式）
- [x] Skills 系统（技能发现 + prompt 注入）
- [x] `get_memory` 工具
- [x] `search_files` 工具
- [x] `update_plan` 工具
- [x] 会话持久化（JSONL 日志 / 历史回放）
- [x] Model Profile（不同模型的参数配置）

---

### Phase 11: 架构整改 ✅
**目标**：基于代码评审反馈，系统性修复架构与交互缺陷。

- [x] TUI 多行编辑（Alt+Enter 换行、↑↓ 导航、ESC 清空）
- [x] 配置迁移：dotenv → TOML（`~/.cclin/config.toml`，三层优先级合并）
- [x] 系统提示词增强（参考 Claude Code 风格重写 prompt.md）
- [x] 上下文防爆改进（read_file 行数限制、list_directory 噪声过滤、压缩保留近期消息）
- [x] Provider 抽象层（LLMProvider 接口 + Registry + OpenAIProvider）
- [ ] 多模态支持（图片粘贴 + 多模态消息格式）

**产出**：配置更安全、提示词更专业、上下文更可控、Provider 可扩展。


### Phase 12：学习闭环系统 ✅
**目标**：Agent 具备跨会话记忆、历史检索、Skill 自我建立能力。

- [x] `remember_note` 工具（写入 `~/.cclin/memories/notes.md`，带日期 + 分类 tag）
- [x] 扩展 `get_memory("notes")` 支持读取跨会话笔记（不存在时友好提示而非报错）
- [x] `search_history` 工具（扫描 `~/.cclin/history/*.jsonl`，只匹配 `final` 事件，按时间倒序返回）
- [x] `create_skill` 工具（写入 `~/.cclin/skills/<name>/SKILL.md`，与 Skills 工具系统完全兼容，下次启动自动注入）
- [x] 接入 `historySink`：`handleMiddlewareReady` 中创建 `JsonlHistorySink`，会话历史与每日 JSONL 文件真正落地
- [x] `prompt.md` 补充记忆工具使用时机指导（when to write / search / create skill）

**产出**：Agent 能跨会话记忆用户偏好、回溯历史解法并将解题模式提炼为可复用 Skill，实现无需模型微调的持续进化能力。


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
├── PLAN.md                     # 本文件
├── AGENTS.md                   # 项目级 Agent 指令
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                # 入口
    ├── types.ts                # 共享类型
    ├── config/                 # TOML 配置加载器
    │   ├── types.ts            # CclinConfig 类型
    │   ├── loader.ts           # 配置加载逻辑
    │   └── index.ts            # barrel export
    ├── llm/
    │   ├── provider.ts         # LLMProvider 接口 + Registry
    │   └── client.ts           # OpenAI Provider
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

---

## 阶段实现取舍清单 (待完成/可扩展特性)

在先前的开发阶段中，基于"最小可用"与"降低复杂度"原则，对参考实现 (memo-code) 做了一定程度的简化。以下保留各阶段未实现、可作为未来演进的特性清单（提炼自 docs 学习笔记）：

### Phase 3 工具系统
- **动态输入校验**：目前采用手写基础校验逻辑，未引入 `zod` 进行工具 Input Schema 的复杂验证。

### Phase 4 审批与编排
- **细粒度风险分级**：当前仅依赖工具的 `isMutating` 进行布尔值判定。未实现独立的工具风险分类器（三级风险 read/write/execute 映射与 auto/dangerous/strict 全局模式管控）。
- **审批持久化与并发**：暂未支持完整的并发执行 (Promises 并行模式)，以及独立格式化的 MCP Tool Result 截断/兼容。

### Phase 5 Prompt 管理系统
- **灵活的模板加载**：目前限定在同目录读取 `prompt.md`，不支持多级路径回溯查找以及通过系统环境变量动态覆盖 Prompt 模板基准路径。

### Phase 6 上下文压缩
- **原生 Token 计算**：受限于免编译诉求选用了 `gpt-tokenizer`，未来可升级为更精确的 OpenAI 官方 `@dqbd/tiktoken`（WASM 原生绑定）。
- ~~**更精细的留存机制**~~：✅ 已实现 `COMPACTION_TAIL_WINDOW`，压缩时保留最近 N 条消息。
- **强制截断防护**：压缩后如果依然超出设定的上下文阈值，目前仅触发日志警告，缺少严格的末位截断或保护性阻断执行机制。

### Phase 9 MCP 集成
- [x] **连接协议扩展**：`McpClientPool` 已支持 stdio / StreamableHTTP / SSE 三种传输方式，含 OAuth 凭据（Bearer Token / Client Credentials）注入，HTTP 模式自动 fallback SSE。
- **本地发现缓存**：缺乏完整的缓存系统，每次 Agent 启动都需发起“进程启动 -> 发现工具列表”的完整子流程；由于未实现 `CallToolResult` 标准化处理，难以执行超量回查防护。

### Phase 10 Skills 系统
- **配置解析扩展**：Frontmatter 解析器极度简化，仅能识别键值对位于同一行的基本属性，不兼容多行值或数组结构解析。
- **扫描规则弹性**：采用原生 `fs.readdir` 进行限制层级的检索（固定最大 4 层，扫描两处指定根目录），未来可替换为 `fast-glob` 库提供无死角的按需深层检索能力。


## 补充
- 配置文件支持
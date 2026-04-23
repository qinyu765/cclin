# 仓库指南

## 项目结构与模块

- 项目计划表 `PLAN.md`，注意同步实际情况，跟踪最新进度和需求
- 入口文件：`src/index.ts`（Ink TUI 启动、Session 创建、工具注册、Slash 命令路由）
- `src/tui/`：终端 UI 层（Ink 组件、输入编辑器、输出渲染、Slash 命令注册表、聊天时间线状态管理、审批覆盖层）
- `src/runtime/`：会话状态机（Session）、ReAct 循环引擎、上下文压缩、Hook 系统、Skills 加载、系统提示词构建、历史持久化
- `src/tools/`：内置工具 + MCP 工具编排；包含审批管理器、工具路由器、安全验证；测试文件与实现文件放在一起，使用 `*.test.ts` 命名
- `src/llm/`：LLM Provider 抽象层，已实现 OpenAI 兼容（`client.ts`）、Anthropic 原生（`anthropic-provider.ts`）、Gemini 原生（`gemini-provider.ts`）
- `src/config/`：TOML 配置加载器，支持 `~/.cclin/config.toml` + 环境变量覆盖
- `src/utils/`：通用工具（BPE 分词器）
- `src/types.ts`：全局共享类型定义（ChatMessage、LLMResponse、工具接口、Hook 类型等）
- `docs/`：开发文档和学习笔记；按阶段归档
- 根脚本由 `package.json` 管理；需要 Node.js >=20 和 pnpm
- 类型/路径别名在 `tsconfig.json` 中
- 运行时配置和日志默认存储在 `~/.cclin/` 中，可以通过 `CCLIN_HOME` 环境变量重定向
- 上下文窗口由 `contextWindow` 参数决定；自动压缩阈值由 `compactThreshold` 控制（默认 `80`%）

## 构建、测试与开发

- 安装依赖：`pnpm install`
- 本地开发：`pnpm dev`（使用 tsx 直接运行，交互式 TUI）
- 构建：`pnpm run build`（编译 TypeScript 并复制 `prompt.md` 到 `dist/`）
- 类型检查：`pnpm run typecheck`
- 测试：`pnpm test`（vitest run）；开发时：`pnpm run test:watch`
- 常见本地问题：缺少 API Key 环境变量会触发启动报错；确保 `.env` 或 `~/.cclin/config.toml` 中配置了 `api_key`
- 永远不要为旧实现做兼容性妥协。重构和改进是被鼓励的，但不应以牺牲代码质量、可维护性或安全性为代价

## 核心架构

- **ReAct 循环**（`react-loop.ts`）：Think → Act → Observe 循环，纯函数设计，所有依赖通过 `RunTurnDeps` 注入
- **Session**（`session.ts`）：状态管理层，持有 history、调用 runTurn、管理上下文压缩、发射 Hook 事件
- **Hook 系统**（`hooks.ts`）：`onTurnStart` → `onAction` → `onObservation` → `onFinal` → `onContextUsage` → `onContextCompacted`；TUI 通过 `AgentMiddleware` 接口订阅
- **工具路由**（`router.ts`）：统一管理内置工具 + MCP 工具，提供 `executeTool` 和 `toOpenAITools()` 接口
- **审批管理**（`approval.ts`）：支持 `always` / `once` / `session` 三种策略
- **LLM Provider**（`provider.ts`）：注册表模式，`createProvider(name)` 返回对应实现；均需实现 `createCallLLM` 接口
- **Slash 命令**（`commands.ts`）：中央注册表设计，添加新命令只需追加 `CommandDef`，补全 / 路由 / 帮助文本自动更新
- **并行工具调用**：LLM 可返回多个 `tool_use` block，TUI 通过 `StepView.actions[]` 数组渲染所有并行调用
- **输入历史**：Shell 风格 ↑/↓ 导航，与多行编辑兼容（首行 ↑ 回溯历史，末行 ↓ 前进历史）
- **Subagent**：支持同步（`spawn_agent`）和异步（`spawn/send/wait/close`）两种模式

## 代码风格与命名

- 注意代码的可维护性以及可读性
- 语言：TypeScript + ESM。保持清晰的模块边界：`runtime/`（核心逻辑）、`tools/`（能力）、`tui/`（交互 UI）、`llm/`（Provider 适配）
- 使用 Prettier 进行格式化，缩进为 2 个空格
- 保持现有的命名约定（如 `config.ts`、`*.test.ts`），优先使用显式导出
- 优先使用纯函数。将副作用保留在入口（`index.ts`）或工具适配器中
- 保持文档同步：当公共行为、参数或输出发生变化时，更新 `README.md` 和相关 `docs/` 文档

## 测试指南

- 将测试文件放在源文件旁边，使用 `*.test.ts` 命名；遵循现有示例（`approval.test.ts`、`router.test.ts`、`compaction.test.ts`）
- 使用 `pnpm test path/to/file.test.ts` 运行聚焦测试
- 新功能必须覆盖正常路径和错误分支
- 更改 Provider / 配置流程时，添加固定测试用例以防回归
- 确保新功能有适当的测试覆盖（70% 以上）

## 提交与 PR 约定

- 保持小写提交前缀：`feat:`、`fix:`、`chore:`、`refactor:`、`ci:`、`docs:`，并带有简短的作用域
- 推荐的分支名称：`feature/<topic>`、`fix/<topic>`、`docs/<topic>`
- PR 应包括：更改摘要、风险/回滚说明以及验证步骤（`pnpm test`、`pnpm run typecheck`）
- 如果 CI 失败，请在请求审查前在本地重现并修复

## 安全与配置说明

- 永远不要提交密钥。运行时密钥从环境变量（`OPENAI_API_KEY`、`DEEPSEEK_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY`）或 `~/.cclin/config.toml` 中读取
- 工具代码应防御性地验证路径（`safety.ts` 提供路径安全检查）和网络调用
- MCP Server 配置存放在 `~/.cclin/mcp.json`，支持 stdio 和 SSE 两种传输方式
- 升级依赖项时，注意许可证兼容性和包大小。为网络请求添加合理的超时和清晰的错误信息
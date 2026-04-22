# cclin

> 从零构建的生产级 CLI Code Agent，对标 [memo-code](https://github.com/anthropics/claude-code) 架构。

一个运行在终端里的 AI 编程助手，能读写文件、执行命令、调用 MCP 工具，在本地环境中完成软件工程任务。

## 特性

- **ReAct 循环** — 手写 Think → Act → Observe 循环，脱离 SDK 自动编排
- **11 个内置工具** — `read_file` / `write_file` / `edit_file` / `bash` / `list_directory` / `search_files` / `update_plan` / `get_memory` / `remember_note` / `search_history` / `create_skill`
- **MCP 集成** — 通过配置文件接入任意 MCP Server 的外部工具
- **Ink TUI** — 基于 React + Ink 的终端界面，实时展示工具调用和流式输出
- **多行编辑** — Alt+Enter 换行、↑↓ 多行导航、ESC 清空输入
- **审批系统** — 危险操作自动暂停等待确认（always / once / session 三级策略）
- **TOML 配置** — 用户级 `~/.cclin/config.toml`，首次运行自动生成模板
- **多 Provider 原生支持** — 统一 LLMProvider 接口，支持 OpenAI、Anthropic (Claude)、Google Gemini 三大原生 SDK 直连，同时兼容 DeepSeek/NewAPI 等 OpenAI 兼容 API
- **上下文压缩** — 长对话自动压缩，保留近期消息不丢失关键上下文
- **Skills 系统** — 发现并加载 `SKILL.md` 技能文件，扩展 Agent 能力
- **Model Profile** — 不同模型的参数差异化配置
- **会话持久化** — JSONL 日志记录，支持历史回放
- **多模态输入** — `/image <path>` 附加图片，与支持 Vision 的模型（gpt-4o 等）对话
- **Subagent 系统** — 父 Agent 可派遣子 Agent 完成子任务：阻塞式 `spawn_agent` 和异步式 `send_input` / `wait` / `close_agent` 两套方案
- **学习闭环** — `remember_note` 跨会话笔记、`search_history` 历史检索、`create_skill` Skill 自我建立，无需模型微调的持续进化能力

## 技术栈

- **核心交互**：[React](https://react.dev/) + [Ink](https://github.com/vadimdemedes/ink) 构建终端 TUI
- **终端美化**：[unicode-animations](https://github.com/hcfy/unicode-animations) 实现平滑的终端动画
- **工具扩展**：[@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) (MCP)

## 安装

**方式一：从 npm 安装（推荐）**

```bash
npm install -g @hflin/cclin
cclin
```

**方式二：从源码构建**

```bash
# 编译 TypeScript
pnpm run build

# 本地全局链接
npm link
cclin
```

## 快速开始

```bash
# 克隆项目
git clone <repo-url> && cd cclin

# 安装依赖
pnpm install

# 配置 API Key（首次运行会自动生成 ~/.cclin/config.toml）
# 编辑 config.toml 填入你的 API Key
# 或设置环境变量 OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY

# 启动
pnpm run dev
```

## 配置

### 配置文件（`~/.cclin/config.toml`）

首次运行时自动生成带注释的模板文件。主要配置项：

**OpenAI / DeepSeek（默认）**

```toml
[llm]
provider = "openai"
api_key = "sk-xxx"
base_url = "https://api.openai.com/v1"
model = "gpt-4o-mini"
```

**Anthropic (Claude)**

```toml
[llm]
provider = "anthropic"
api_key = "sk-ant-xxx"
model = "claude-sonnet-4-20250514"
```

**Google Gemini**

```toml
[llm]
provider = "gemini"
api_key = "AIzaSy-xxx"
model = "gemini-2.5-pro"
```

```toml
[approval]
policy = "once"                 # always / once / session
```

环境变量覆盖：`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`、`OPENAI_BASE_URL`、`MODEL_NAME`。
`CCLIN_HOME` 可重定向配置目录（默认 `~/.cclin`）。

### 扩展文件

- **`AGENTS.md`** — 放在项目根目录，包含项目级开发规范
- **`~/.cclin/SOUL.md`** — 用户人格偏好（语言、风格等）
- **`.agents/skills/*/SKILL.md`** — 技能文件
- **`mcp_config.json`** — MCP Server 配置

## 快捷键

| 快捷键 / 命令 | 说明 |
|------|------|
| `Enter` | 提交输入 |
| `Alt+Enter` / `Ctrl+J` | 插入换行（多行输入） |
| `ESC` | 清空当前输入 |
| `↑↓` | 多行光标移动 |
| `Ctrl+U` | 删除到当前行首 |
| `Ctrl+A` / `Ctrl+E` | 跳转到行首 / 行尾 |
| `/compact` | 手动压缩上下文 |
| `/retry` | 重新发送上次输入 |
| `/approve <mode>` | 切换审批策略 |
| `/image <path> [描述]` | 附加图片文件（支持 png/jpg/webp/gif，≤20 MB） |
| `Ctrl+C` | 退出 |

## 架构

```
cclin/
├── src/
│   ├── index.ts              # 入口 + TUI 桥接
│   ├── types.ts              # 共享类型定义（含 ContentPart 多模态类型）
│   ├── config/               # TOML 配置加载器
│   ├── llm/
│   │   ├── provider.ts       # LLMProvider 接口 + Registry
│   │   ├── client.ts         # OpenAI Provider（流式/非流式＋ Vision 多模态）
│   │   ├── anthropic-provider.ts  # Anthropic Provider（原生 SDK）
│   │   └── gemini-provider.ts     # Gemini Provider（原生 SDK）
│   ├── runtime/
│   │   ├── session.ts        # 会话管理
│   │   ├── react-loop.ts     # ReAct 循环引擎
│   │   ├── prompt.ts         # 系统提示词组装
│   │   ├── compaction.ts     # 上下文压缩
│   │   ├── hooks.ts          # 生命周期 Hook 系统
│   │   ├── skills.ts         # 技能发现与加载
│   │   ├── model-profile.ts  # 模型参数配置
│   │   └── history.ts        # JSONL 会话持久化
│   ├── tools/
│   │   ├── router.ts         # 工具路由（Native + MCP）
│   │   ├── orchestrator.ts   # 工具编排器
│   │   ├── approval.ts       # 审批管理器
│   │   ├── spawn-agent.ts    # 阻塞式 Subagent
│   │   ├── subagent-manager.ts  # 异步 Subagent 生命周期
│   │   ├── subagent-tools.ts # 异步 Subagent 工具套件
│   │   ├── remember-note.ts  # 跨会话笔记写入
│   │   ├── search-history.ts # 历史 JSONL 检索
│   │   ├── create-skill.ts   # Skill 自我建立
│   │   └── *.ts              # 各工具实现
│   ├── tui/
│   │   ├── image-attach.ts   # 图片附件处理（解析/验证/base64 编码）
│   │   └── *.tsx             # Ink TUI 组件
│   └── utils/                # 工具函数
├── AGENTS.md                 # 项目级 Agent 指令
├── PLAN.md                   # 开发路线图
└── docs/                     # 学习笔记
```

## 多模态输入

在输入框中先键入 `/image` 命令附加图片，再键入文字描述回车发送：

```
/image ./screenshot.png 这张截图里面有什么 bug？
```

- 支持格式：`png` / `jpg` / `jpeg` / `webp` / `gif`
- 单次最大 **20 MB**，超出会在提交前提示错误
- TUI 中显示待附加标记 `[Image #1] filename.png`，回车后将图片与文字一起发送给 LLM
- **模型要求**：需配置支持 Vision 的模型（如 `gpt-4o`），否则 API 会返回错误

## Subagent 系统

cclin 支持「父 Agent 派遣子 Agent」模式，适合并行子任务、完全隔离的工作界面等场景。

**阻塞式（spawn_agent）**：父 Agent 调用后等待子 Agent 完成并返回结果。

```
请使用 spawn_agent 完成以下任务并返回结果：
给 src/utils/ 目录下所有文件生成单元测试
```

**异步式（send_input / wait / close_agent）**：父 Agent 可持续其他工作，届时 `wait` 收取结果。子 Agent 全部共享主 Agent 的工具集和审批策略（子 Agent 使用 `session` 级，即全量自动批准）。

## 测试

```bash
pnpm test          # 运行所有测试
pnpm test:watch    # 监视模式
pnpm typecheck     # TypeScript 类型检查
```

## License

MIT

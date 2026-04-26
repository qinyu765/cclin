# cclin
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
- **多模态输入** — `Alt+V` 从剪贴板粘贴图片，与支持 Vision 的模型（gpt-4o 等）对话
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
| `/approve <mode>` | 切换审批策略 |
| `Alt+V` | 附加剪切板里的图片（支持 png/jpg/webp/gif，≤20 MB） |
| `Ctrl+C` | 退出 |

## 测试

```bash
pnpm test          # 运行所有测试
pnpm test:watch    # 监视模式
pnpm typecheck     # TypeScript 类型检查
```

## License

MIT

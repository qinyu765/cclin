# cclin

> 从零构建的生产级 CLI Code Agent，对标 [memo-code](https://github.com/anthropics/claude-code) 架构。

一个运行在终端里的 AI 编程助手，能读写文件、执行命令、调用 MCP 工具，在本地环境中完成软件工程任务。

## ✨ 特性

- **ReAct 循环** — 手写 Think → Act → Observe 循环，脱离 SDK 自动编排
- **8 个内置工具** — `read_file` / `write_file` / `edit_file` / `bash` / `list_directory` / `search_files` / `update_plan` / `get_memory`
- **MCP 集成** — 通过配置文件接入任意 MCP Server 的外部工具
- **Ink TUI** — 基于 React + Ink 的终端界面，实时展示工具调用和流式输出
- **审批系统** — 危险操作自动暂停等待确认（always / once / session 三级策略）
- **上下文压缩** — 长对话自动压缩，不丢失关键上下文
- **Skills 系统** — 发现并加载 `SKILL.md` 技能文件，扩展 Agent 能力
- **Model Profile** — 不同模型的参数差异化配置
- **会话持久化** — JSONL 日志记录，支持历史回放

## 🚀 快速开始

```bash
# 克隆项目
git clone <repo-url> && cd cclin

# 安装依赖
pnpm install

# 配置 API Key
cp .env.example .env
# 编辑 .env，填入你的 OPENAI_API_KEY

# 启动
pnpm run dev
```

## ⌨️ 内置命令

| 命令 | 说明 |
|------|------|
| `/compact` | 手动压缩上下文 |
| `/retry` | 重新发送上一次输入 |
| `/approve <mode>` | 切换审批策略（`always` / `once` / `session`） |
| `Ctrl+C` | 退出 |

## 🏗️ 架构

```
cclin/
├── src/
│   ├── index.ts              # 入口 + TUI 桥接
│   ├── types.ts              # 共享类型定义
│   ├── llm/
│   │   └── client.ts         # OpenAI SDK 封装（流式/非流式）
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
│   │   └── *.ts              # 各工具实现
│   ├── tui/                  # Ink TUI 组件
│   └── utils/                # 工具函数
├── .env.example              # 配置模板
├── AGENTS.md                 # 项目级 Agent 指令
├── PLAN.md                   # 开发路线图
└── docs/                     # 学习笔记（Phase 2-10）
```

## ⚙️ 配置

### 环境变量（`.env`）

| 变量 | 必填 | 默认值 | 说明 |
|------|:----:|--------|------|
| `OPENAI_API_KEY` | ✅ | — | OpenAI 兼容 API Key |
| `OPENAI_BASE_URL` | — | `https://api.openai.com/v1` | API 地址（支持 DeepSeek 等） |
| `MODEL_NAME` | — | `gpt-4o-mini` | 模型名称 |
| `CCLIN_HOME` | — | `~/.cclin` | 用户级配置目录 |

### 扩展文件

- **`AGENTS.md`** — 放在项目根目录，包含项目级开发规范
- **`~/.cclin/SOUL.md`** — 用户人格偏好（语言、风格等）
- **`.agents/skills/*/SKILL.md`** — 技能文件
- **`mcp_config.json`** — MCP Server 配置

## 📦 构建

```bash
# 编译 TypeScript
pnpm run build

# 全局安装（可选）
npm link
cclin
```

## 🧪 测试

```bash
pnpm test          # 运行所有测试
pnpm test:watch    # 监视模式
pnpm typecheck     # TypeScript 类型检查
```

## 📄 License

MIT

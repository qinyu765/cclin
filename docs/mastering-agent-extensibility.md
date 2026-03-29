# 掌握 AI 编程工具的可扩展能力：Skills、Subagent、Prompt 与 MCP

## 0. 核心观点

同一个模型在 AI IDE 插件（Cursor/Windsurf）、CLI 工具（Claude Code/Codex/Gemini CLI）和客户端应用中表现不同，根本原因是 **system prompt、工具集、上下文注入、权限边界、输出格式约束** 全都不一样。追求"哪个壳层更强"是噪声——真正该做的是 **掌握每个平台提供的可扩展能力**，把"不可控变量"变成你的杠杆。

本文聚焦四大可扩展能力：

1. **Custom Prompts** — 持久化指令注入
2. **Skills** — 可复用的专项知识包
3. **Subagent** — 任务分治与上下文隔离
4. **MCP (Model Context Protocol)** — 标准化工具/数据桥接
5. **Hooks & Workflows** — 生命周期拦截与流程自动化

---

## 1. Custom Prompts：持久化指令注入

### 1.1 为什么这是最基础的可控变量

AI Agent 的行为 = 模型能力 × 指令质量。不同平台允许你通过不同机制注入持久化指令，这是你能施加的 **最直接影响**。

### 1.2 各平台的指令系统对比

| 平台 | 指令文件 | 格式 | 作用域 | 特色 |
|:---|:---|:---|:---|:---|
| **Claude Code** | `CLAUDE.md` | Markdown | 全局 / 项目 / 子目录 | 层级覆盖，`/init` 自动生成 |
| **Cursor** | `.cursor/rules/*.mdc` | Markdown + YAML | 按 glob 匹配文件 | 粒度最细，编辑特定文件时才激活 |
| **Codex CLI** | `AGENTS.md` / `codex.md` | Markdown | 项目级 | 偏自动化场景 |
| **Gemini CLI** | `GEMINI.md` | Markdown | 项目级 | 与 Google 生态深度集成 |

### 1.3 Claude Code 的指令层级

```
~/.claude/CLAUDE.md          ← 全局（个人偏好，跨项目）
./CLAUDE.md                  ← 项目级（团队共享，提交到 Git）
./src/CLAUDE.md              ← 子目录级（仅影响该目录下的工作）
.claude/settings.json        ← 行为配置（权限、MCP 等）
.claude/settings.local.json  ← 本地覆盖（gitignore）
```

### 1.4 高级技巧

**Claude Code 的 system prompt 覆盖：**

- `--append-system-prompt "..."` — 在系统指令末尾追加内容（安全，推荐）
- `--system-prompt "..."` — 替换几乎整个系统指令（核武器级别，慎用）

**Cursor 的 glob 粒度规则（`.mdc` 格式）：**

```yaml
# .cursor/rules/react-components.mdc
---
globs: ["src/components/**/*.tsx"]
alwaysApply: false
---
使用函数组件 + React.FC 类型。
禁止 class 组件。
所有 props 必须显式定义接口。
```

只在编辑匹配文件时激活——避免"指令过载"导致遵循度下降。

### 1.5 最佳实践

1. **当新人文档写** — 假设 Agent 是新入职成员，写出它需要知道的一切
2. **精简优先** — 超过 500 行就拆分，主文件只放通用规则
3. **提交到 Git** — 让团队共享统一的 Agent 行为
4. **迭代优化** — Agent 犯了错 → 加一条规则防止复现

---

## 2. Skills：可复用的专项知识包

### 2.1 什么是 Skill

Skill 是将 **特定领域的知识、流程、脚本** 打包成可复用单元的机制。Agent 按需加载，不是每次都把所有东西塞进上下文。

> 类比：Prompt 是"通识教育"，Skill 是"职业培训手册"。

### 2.2 Claude Code 的 Skills 系统

**目录结构：**

```
.claude/skills/deploy-to-prod/     ← 项目级
  SKILL.md                         ← 主指令文件（必需）
  scripts/deploy.sh                ← 辅助脚本
  examples/rollback-example.md     ← 参考示例

~/.claude/skills/git-push/         ← 全局级（跨项目可用）
  SKILL.md
```

**SKILL.md 核心格式：**

```yaml
---
name: deploy-to-prod
description: >
  Handles production deployment. Use when user says "deploy",
  "push to prod", or "release".
---
# Production Deployment
## Pre-flight Checklist
1. Ensure all tests pass
2. Check for uncommitted changes
## Deployment Steps
...
```

**关键机制：**

| 字段 | 作用 |
|:---|:---|
| `name` | 唯一标识符，自动注册为 `/name` 斜杠命令 |
| `description` | Agent 据此判断**何时**自动加载 Skill（务必写得具体） |
| `disable-model-invocation: true` | 仅允许用户手动 `/invoke`，防止 Agent 自动触发有副作用的操作 |
| `user-invocable: false` | 仅 Agent 内部使用，不暴露给用户 |

### 2.3 Gemini CLI 的 Skills

Gemini CLI 使用类似的目录结构，但将其称为 **Agent Skills**：

- 按需加载，不占用初始上下文窗口
- 适合领域专精型知识（安全审计、云部署等）
- 与 Extension 系统配合（Extension = 分发包，包含 Skills + MCP 配置 + 斜杠命令）

### 2.4 Skill 设计原则

1. **单一职责** — 一个 Skill 做一件事（deploy / review / test）
2. **渐进式披露** — `SKILL.md` 控制在 500 行内，细节放 `references/` 子目录
3. **为 AI 写指令** — 不是给人看的文档，要精确、可执行、无歧义
4. **测试触发** — 创建后模拟场景看 Agent 是否正确激活；不触发就改 `description`

---

## 3. Subagent：任务分治与上下文隔离

### 3.1 为什么需要 Subagent

单 Agent 处理复杂任务的核心问题：

- **上下文污染** — 中间推理、工具输出、研究笔记占满窗口
- **注意力分散** — 所有信息共存一个窗口，模型难以聚焦
- **错误传播** — 一个子任务的错误影响全局

Subagent 的解法：**把复杂任务拆分给专职子代理，每个子代理有独立上下文**。

### 3.2 架构模型

```
┌─────────────────────────────────────┐
│         主 Agent (Parent)            │
│  管理全局目标，分配子任务              │
│                                     │
│  ┌───────────┐    ┌───────────┐    │
│  │ Subagent A │    │ Subagent B │    │
│  │ 代码研究    │    │ 浏览器测试  │    │
│  │ 只读权限    │    │ 浏览器权限  │    │
│  │ 独立上下文  │    │ 独立上下文  │    │
│  └─────┬─────┘    └─────┬─────┘    │
│        │ 摘要结果         │ 摘要结果   │
│        └────────┬────────┘          │
│                 ▼                   │
│          主 Agent 汇总              │
└─────────────────────────────────────┘
```

### 3.3 Subagent 的定义方式

**Claude Code（`.claude/agents/` 目录）：**

```yaml
---
name: code-reviewer
description: Reviews code for security and performance issues
allowed_tools: [read_file, grep_search, view_file_outline]
---
You are a senior code reviewer. Focus on:
1. Security vulnerabilities
2. Performance bottlenecks
3. API misuse patterns
Never suggest formatting or style changes.
```

**关键配置：**

- **Custom System Prompt** — 定义子代理角色（架构师 / 审查者 / 调试者）
- **Scoped Tool Permissions** — 限制可用工具（审查者只读、开发者可写）
- **Context Isolation** — 子代理在独立上下文窗口运行，仅返回摘要

### 3.4 典型使用场景

| 场景 | 主 Agent 做什么 | Subagent 做什么 |
|:---|:---|:---|
| 大型重构 | 规划变更策略 | 研究 Agent 分析依赖图，执行 Agent 逐模块修改 |
| E2E 测试 | 协调测试计划 | 浏览器 Subagent 操作页面、截图、验证 |
| Code Review | 汇总发现 | 安全 Subagent 扫描漏洞，性能 Subagent 分析瓶颈 |
| 文档生成 | 确定大纲 | 代码分析 Subagent 提取 API 签名和使用示例 |

### 3.5 注意事项

1. **任务描述要精确** — Subagent 没有你的对话历史，必须自包含
2. **限制工具权限** — 最小权限原则，审查者不需要写文件
3. **只返回摘要** — 不要让 Subagent 的中间过程回流到主上下文
4. **同步 vs 异步** — 简单任务同步等待，复杂任务可后台并行

---

## 4. MCP (Model Context Protocol)：标准化工具桥接

### 4.1 什么是 MCP

MCP 是连接 AI Agent 与外部系统的 **开放标准协议**。

> 类比：MCP 之于 AI Agent，如同 USB-C 之于硬件设备——一次实现，处处兼容。

没有 MCP 之前：每个 AI 工具 × 每个外部服务 = N × M 个定制集成。
有了 MCP 之后：每个服务只需写一个 MCP Server，所有支持 MCP 的客户端自动兼容。

### 4.2 核心三要素

```
┌─────────────┐    MCP Protocol     ┌─────────────┐
│  AI Client   │ ◄═══════════════► │  MCP Server  │
│ (Claude Code │                    │ (GitHub /    │
│  Cursor 等)  │                    │  DB / Jira)  │
└─────────────┘                    └─────────────┘
```

| 组件 | 类型 | 说明 |
|:---|:---|:---|
| **Tools** | 可执行函数 | Agent 可调用的操作（写入数据库、触发部署、创建 PR） |
| **Resources** | 只读数据源 | 提供上下文（文件内容、数据库 schema、API 文档） |
| **Prompts** | 指令模板 | 预置的交互模式，简化复杂操作 |

### 4.3 实际应用示例

**配置方式（Claude Code `.claude/settings.json`）：**

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_xxx" }
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": { "DATABASE_URL": "postgresql://..." }
    }
  }
}
```

**启用后 Agent 获得的能力：**

- 直接操作 GitHub（创建 Issue、PR、Review）
- 查询/修改数据库
- 发送 Slack 通知
- 操控 Playwright 浏览器
- 执行 Grok/Exa 搜索

### 4.4 MCP 的战略意义

1. **生态效应** — 社区持续贡献 MCP Server，你的 Agent 能力随之增长
2. **可迁移性** — 换 AI 客户端时，MCP Server 无需重写
3. **安全边界** — OAuth 2.0 集成、权限审批、操作审计
4. **动态发现** — Agent 运行时自动发现可用工具的 schema，无需硬编码

---

## 5. Hooks & Workflows：生命周期拦截与流程自动化

### 5.1 Hooks：在 Agent 循环中插入确定性逻辑

Hooks 允许你在 Agent 执行的关键节点插入 **你自己的脚本或 HTTP 请求**，不依赖模型的"自觉"。

**核心生命周期事件：**

| 事件 | 触发时机 | 典型用途 |
|:---|:---|:---|
| `PreToolUse` | 工具执行**前** | 拦截危险命令、注入凭证、验证参数 |
| `PostToolUse` | 工具执行**后** | 审计日志、自动格式化、资源清理 |
| `UserPromptSubmit` | 用户消息发送前 | 注入额外上下文（Jira ticket、git diff） |
| `SessionStart/Stop` | 会话开始/结束 | 初始化/清理状态 |
| `SubagentStart/Stop` | 子代理启动/结束 | 跟踪子任务 |
| `Notification` | Agent 需要用户注意 | 自定义通知渠道 |

**Claude Code 的 Hook 配置（`settings.json`）：**

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "python validate_command.py"
      }]
    }]
  }
}
```

**工作原理：**
1. 事件触发 → 检查注册的 handler
2. 通过 matcher（正则）筛选是否匹配
3. 以 JSON 格式通过 stdin 传递事件数据
4. 脚本返回 exit code 决定允许/阻止/修改

### 5.2 Workflows：可重复的自动化流程

**Claude Code 的 Workflow 文件（`.claude/workflows/`）：**

```markdown
---
description: Run full CI check before merge
---
1. Run linter: `npm run lint`
2. Run all tests: `npm test`
3. Check for type errors: `npx tsc --noEmit`
4. Generate coverage report
5. Summarize results
```

**Gemini CLI 的斜杠命令（`.toml` 格式）：**

```toml
[commands.pr-review]
description = "Review current PR for issues"
template = """
Review the current PR. Check for:
1. Security vulnerabilities
2. Performance issues
3. Missing tests
Use {{args}} as focus area if provided.
"""
```

### 5.3 Hooks vs Workflows 的区别

| 维度 | Hooks | Workflows |
|:---|:---|:---|
| 触发方式 | **自动**（事件驱动） | **手动**（用户调用 `/command`） |
| 执行者 | 你的脚本/HTTP 端点 | Agent 本身 |
| 目的 | 拦截、审计、安全门禁 | 标准化复杂多步任务 |
| 类比 | Git hooks / CI webhooks | Makefile / npm scripts |

---

## 6. 全景心智模型

### 6.1 五层可控架构

```
┌─────────────────────────────────────────────┐
│  Layer 5: Workflows                         │
│  可重复的多步流程（/deploy, /review）          │
├─────────────────────────────────────────────┤
│  Layer 4: Hooks                             │
│  生命周期拦截（安全、审计、注入）               │
├─────────────────────────────────────────────┤
│  Layer 3: MCP                               │
│  标准化外部工具/数据桥接                       │
├─────────────────────────────────────────────┤
│  Layer 2: Skills & Subagents                │
│  专项知识包 + 任务分治                         │
├─────────────────────────────────────────────┤
│  Layer 1: Custom Prompts                    │
│  持久化指令（CLAUDE.md / .cursorrules）       │
├═════════════════════════════════════════════┤
│  Layer 0: Model (不可控)                     │
│  Claude / GPT / Gemini / ...                │
└─────────────────────────────────────────────┘
```

**关键洞察：** Layer 0 是你无法控制的（模型能力由厂商决定），但 Layer 1-5 全部在你手中。同一个模型在不同平台表现不同，本质上是因为 Layer 1-5 的配置不同。

### 6.2 行动建议

**今天就做：**
1. 为你的项目创建 `CLAUDE.md`（或对应工具的指令文件）
2. 把重复执行的操作封装为一个 Workflow

**本周做：**
3. 配置至少一个 MCP Server（推荐 GitHub）
4. 把一个常用流程封装为 Skill

**持续做：**
5. 每次 Agent 犯错 → 更新规则文件，让错误不重现
6. 观察哪些任务占用太多上下文 → 考虑 Subagent 分治
7. 需要确定性保证的环节 → 用 Hook 替代"希望 Agent 记住"

### 6.3 与原文的关系

[原文](./agent-tools-usage-guide.md) 的核心观点——"从模型崇拜转向工具编排"——是完全正确的。本文是对该思路的 **具体落地**：不再泛泛地说"要掌握工具"，而是明确告诉你 **有哪些工具可以掌握、怎么配置、怎么组合**。

一句话总结：

> 模型决定天花板，但 Prompts × Skills × Subagents × MCP × Hooks 决定你每天能稳定触到天花板的哪个位置。

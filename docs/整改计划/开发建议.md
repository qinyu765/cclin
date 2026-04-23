## 当前主要问题 / 短板

## 1. “production-grade” 现在更多体现在规划上，不在实现上
`package.json` 很轻，当前依赖只有：

- `openai`
- `dotenv`
- `typescript`
- `tsx`

这意味着现在还是**原型工程**，不是生产工程。
一个真正 production-grade 的 agent CLI，至少通常还会有：

- 测试框架（vitest/jest）
- lint/format（eslint/prettier）
- 日志系统
- 配置管理
- 错误分类与 telemetry
- 持久化/trace
- 更严格的 schema 校验

所以目前更准确的定位应该是：

> **“一个朝生产级方向设计的 agent 原型”**
而不是已经达到 production-grade。

---

## 2. 工具安全还比较浅
`safety.ts` 的思路没问题，但实现上比较“字符串匹配式”，会有一些边界问题：

### 路径校验问题
```ts
const normalized = path.normalize(filePath)
if (normalized.includes('..'))
```
这个检查比较弱。
因为真正的安全边界通常不是“不能有 ..”，而是：

- 必须限制在某个 workspace root 内
- 要做 `resolve()` 后再判断是否越界
- 要处理绝对路径
- 要处理符号链接风险

### 命令分类问题
现在是：
- blocked：包含某些危险命令片段
- confirm：某些前缀

这个在 demo 阶段够用，但真实环境里容易绕过，比如：

- `python -c ...`
- shell 拼接
- `&&` / `;` / subshell
- powershell/cmd/bash 差异

所以现在是**有安全意识，但安全能力还不够工程化**。

---

## 3. 工具执行层还缺少“统一编排器”
现在 `ToolRegistry.createExecuteTool()` 直接执行工具。
这对于 Phase 3 没问题，但后面如果你要加：

- 审批
- 结果截断
- 错误分类
- 重试策略
- 并发策略
- 超时
- 审计日志

就会发现 registry 不是最好的承载位置。
你的 `PLAN.md` 里已经提出 `ToolOrchestrator`，我认为这是下一步最值得做的模块之一。

---

## 4. 运行时与 UI 还有一点耦合
在 `react-loop.ts` / `session.ts` 里有直接 `console.log`：

- `console.log(\`  🔧 [step ${step}] calling tool: ...\`)`
- `console.log(\`\n── Turn ${this.turnIndex} ──\`)`

这会让 runtime 层和 CLI 展示层产生耦合。
如果后面上 Ink TUI、Hook、日志系统，会不太舒服。

更好的方向是：
- runtime 只产出事件 / trace
- UI 层决定怎么渲染
- CLI/TUI/logging 都通过 hook 或 event emitter 接入

这也是你 Phase 7 里 Hook 系统要解决的事。

---

## 5. 缺少测试，是现在最大的工程短板
从项目结构看，**还没有测试目录，也没有测试框架脚本**。
这对于 agent 项目是比较危险的，因为这类系统最容易出问题的地方正是：

- LLM 响应解析
- 工具输入解析
- 路径安全
- 命令安全分级
- ReAct 循环停止条件
- 多工具调用顺序

尤其你的 `runTurn()`、`parseToolArguments()`、`validatePath()` 这些都很适合先补单测。
否则后面功能一多，很容易回归破坏。

---

## 6. Prompt 系统还比较原始
目前 `index.ts` 里还是硬编码：

```ts
systemPrompt: 'You are a helpful coding assistant with access to file and shell tools...'
```

这意味着还没有：

- 项目级 prompt 组装
- 工具描述动态注入策略
- `AGENTS.md` 真正融合到系统提示词
- 用户偏好层
- 环境上下文（pwd/date/platform）

这会直接影响 agent 的稳定性和可控性。
对于 code agent 来说，**Prompt 管理其实是核心能力之一**。

---

## 7. 可观测性还不够
虽然你有 `AgentStepTrace`，这是个很好的基础，但当前还缺：

- 持久化日志
- 单轮完整 trace 输出
- 工具输入/输出结构化记录
- token 消耗统计归档
- 错误类型分类
- 调试模式开关

简单说：现在有“trace 数据结构”，但还没有完整“observability 体系”。

---

## 代码层面我觉得比较好的几个点

### 1. `Session` 和 `runTurn` 的拆分
这是我最认可的地方之一。
后续做测试、hook、session persistence 都方便。

### 2. `LLMResponse -> ContentBlock[]`
这个抽象不错，它弱化了对具体 SDK 返回格式的耦合。
未来如果换 Anthropic、兼容 DeepSeek、接 MCP tool schema，也更容易做兼容层。

### 3. 计划里已经把未来问题想到了
比如：

- context compaction
- hook middleware
- approval manager
- MCP router
- TUI

说明你对 agent 产品的“完整面貌”是有认知的，不只是会调用 API。

---

## 我给这个项目的主观评分

如果按“当前完成度”打分：

### 作为学习型 / 架构型 agent 项目：**8/10**
因为：
- 方向对
- 结构好
- 规划清楚
- 核心闭环通了

### 作为“生产级 CLI Code Agent”当前实现：**5.5/10**
因为：
- 生产特性大多还在计划中
- 测试不足
- 安全和审批未完成
- Prompt / 压缩 / Hook / TUI / 持久化都未落地

---

## 我建议优先做的 5 件事

### 1. 先补测试框架
优先级最高。建议：
- `vitest`
- 给 `react-loop.ts`、`safety.ts`、`registry.ts` 写单测

先把“核心循环 + 安全逻辑”稳住。

---

### 2. 做 `ToolOrchestrator`
把工具执行从 registry 中抽出来，统一处理：

- approval
- timeout
- truncate
- error normalization
- audit log

这是从 demo 走向工程化的关键一步。

---

### 3. 做 Prompt 组装器
至少实现：

- 基础 system prompt 模板
- 自动读 `AGENTS.md`
- 注入工具描述
- 注入 cwd / date / platform

这个会显著提升 agent 的行为稳定性。

---

### 4. 移除 runtime 中的 `console.log`
换成：
- hook
- callback
- event stream

这样后面接 TUI、CLI、日志系统都方便。

---

### 5. 强化 workspace 安全边界
尤其文件工具和 bash：

- 明确 workspace root
- 所有路径 resolve 后检查是否在 root 内
- 对绝对路径做限制
- shell 命令增加 timeout / cwd / env 白名单

---

## 最后评价

我会这样评价这个项目：

> 这是一个**非常有潜力的 agent CLI 原型**。
> 它最强的地方不在功能数量，而在于**架构路线正确、模块边界清晰、扩展点提前预留了**。
> 当前已经超过“简单调用 OpenAI + tools 的 demo”，但距离真正的“生产级”还差一层完整的工程化建设。
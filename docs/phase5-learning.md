# Phase 5 学习笔记 — Prompt 管理系统

> 这份文档记录了 Phase 5 的每一步做了什么、为什么这样做、思考过程是怎样的。
> 目标：读完后你能**独立从零写出同样的代码**。

---

## 第一部分：宏观理解 — Phase 5 在解决什么问题？

### 1.1 Phase 4 的现状与不足

Phase 4 完成后，我们的 agent 已经有了完整的工具执行管线：

```
用户输入 → LLM → 工具调用 → 审批 → 执行 → 观察 → LLM → 最终回答
```

但有一个被"临时凑合"的地方——**系统提示词是硬编码的一句话**：

```typescript
// Phase 4 的 index.ts（第 59 行）
const session = new Session({
    callLLM,
    systemPrompt: 'You are a helpful coding assistant with access to file and shell tools.',
    executeTool: orchestrator.createExecuteTool({ ... }),
})
```

这有什么问题？

1. **不知道当前环境**：LLM 不知道今天是几号、用户是谁、项目在哪个目录
2. **不知道项目规范**：项目有 `AGENTS.md` 定义了代码风格和开发流程，但 LLM 看不到
3. **不支持个性化**：用户想让 agent 说中文？想调整回答风格？没有入口
4. **改提示词要改代码**：想调一下 system prompt 的措辞，得改 `.ts` 文件重新编译

> **Phase 5 的核心任务**：把"硬编码字符串"升级为"动态组装系统"。

### 1.2 从参考项目（memo-code）学到了什么

开始写代码前，我研究了 memo-code 的 `prompt.ts`（204 行）和 `prompt.md`（382 行）：

```
memo-code 的 prompt 系统：
├── prompt.md           — 382行系统提示词模板（极其详细）
└── prompt.ts           — 204行加载逻辑
    ├── renderTemplate()     — 模板变量替换
    ├── resolveUsername()    — 获取用户名
    ├── readProjectAgentsMd() — 读取 AGENTS.md
    ├── readSoulMd()         — 读取 SOUL.md
    ├── loadSkills()         — 技能系统注入（Phase 10 才做）
    └── loadSystemPrompt()   — 主组装函数
```

**memo-code 做了很多我们暂时不需要的事**：

| memo-code 有的 | cclin Phase 5 取舍 |
|---|---|
| 技能系统注入（loadSkills） | ❌ 不做（Phase 10 的事） |
| 多路径 prompt.md 查找 | ❌ 简化（只找同目录） |
| 环境变量覆盖 prompt 路径 | ❌ 简化（当前不需要） |
| MEMO_HOME 自定义目录 | ✅ 简化为 CCLIN_HOME |
| 模板变量替换 `{{key}}` | ✅ 保留（核心特性） |
| AGENTS.md 加载 | ✅ 保留（核心特性） |
| SOUL.md 加载 | ✅ 保留（核心特性） |

> **原则**：学参考项目的**组装管线模式**，但去掉当前阶段不需要的复杂度。

### 1.3 最终设计：组装管线

```
                    ┌─────────────────────────────────────────────┐
                    │            loadSystemPrompt()               │
                    │                                             │
                    │  1. readFile('prompt.md')    ← 模板文件     │
                    │  2. readSoulMd()             ← ~/.cclin/   │
                    │  3. renderTemplate(template, vars)           │
                    │  4. 追加 SOUL.md（如有）                     │
                    │  5. readProjectAgentsMd(cwd) ← 项目目录     │
                    │  6. 追加 AGENTS.md（如有）                   │
                    │                                             │
                    │  return 完整 system prompt                   │
                    └─────────────────────────────────────────────┘
```

---

## 第二部分：模板引擎 — 最简单的"够用"设计

> 对应源码：[prompt.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/runtime/prompt.ts) 前半部分

### 2.1 思考起点："需要多复杂的模板引擎？"

模板引擎的复杂度从低到高：

```
Level 1: 简单替换    {{date}} → "2026-03-26"
Level 2: 条件判断    {{#if hasTools}}...{{/if}}
Level 3: 循环迭代    {{#each tools}}...{{/each}}
Level 4: 完整引擎    Handlebars / Mustache / Nunjucks
```

我选择了 **Level 1**。为什么？

1. 当前只需要 4 个变量：`date`, `user`, `pwd`, `soul_section`
2. 条件逻辑在 TypeScript 代码中处理更清晰（比如"有 SOUL.md 就插入"）
3. 引入模板引擎库增加依赖，对这个规模的需求没必要

### 2.2 正则设计

```typescript
const TEMPLATE_PATTERN = /\{\{\s*([\w.-]+)\s*\}\}/g
```

拆解这个正则：

| 部分 | 含义 |
|------|------|
| `\{\{` | 匹配 `{{`（字面量） |
| `\s*` | 允许空格：`{{ date }}` 和 `{{date}}` 都行 |
| `([\w.-]+)` | 捕获变量名（字母、数字、下划线、点、横杠） |
| `\s*` | 同上，允许尾部空格 |
| `\}\}` | 匹配 `}}`（字面量） |
| `g` | 全局匹配（模板中可能有多个变量） |

**为什么用 `[\w.-]+` 而不是 `\w+`？**

因为未来可能有嵌套变量名如 `{{llm.model}}`。虽然现在用不到，但多支持 `.` 和 `-` 几乎零成本。

### 2.3 renderTemplate 函数

```typescript
function renderTemplate(
    template: string,
    vars: Record<string, string>,
): string {
    return template.replace(
        TEMPLATE_PATTERN,
        (_match, key: string) => vars[key] ?? '',
    )
}
```

**关键设计决策**：

1. **`vars[key] ?? ''`**：未定义的变量替换为空字符串，而不是抛错。
   这样模板中可以有"可选"变量——有就插入，没有就消失。

2. **签名用 `Record<string, string>`**：所有值都是 string。
   这意味着调用方负责序列化（比如 `new Date().toISOString()`）。
   保持模板引擎"只做替换"的单一职责。

3. **为什么不直接用 `template.replaceAll()`？**
   因为 `replaceAll` 不支持正则中的空格容忍和分组捕获。

---

## 第三部分：上下文文件加载 — AGENTS.md 和 SOUL.md

> 对应源码：[prompt.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/runtime/prompt.ts) 中间部分

### 3.1 思考起点："为什么需要加载外部文件？"

系统提示词的信息来源其实是三层的：

```
┌────────────────────────────┐
│  Layer 1: 通用规则          │ ← prompt.md 模板（每个项目都一样）
│  "你是 cclin，一个 CLI 助手" │
├────────────────────────────┤
│  Layer 2: 项目规则          │ ← AGENTS.md（每个项目不同）
│  "用 pnpm，代码注释用中文"  │
├────────────────────────────┤
│  Layer 3: 用户偏好          │ ← SOUL.md（每个用户不同）
│  "回答用中文，语气正式"      │
└────────────────────────────┘
```

三层之间有**优先级**：用户的直接指令 > AGENTS.md > SOUL.md > 模板默认值。
在 prompt 中，后出现的内容优先级更高（因为 LLM 有 recency bias）。
所以我们把 AGENTS.md 放在最后追加。

### 3.2 SOUL_PLACEHOLDER 的设计

在 `prompt.md` 模板中，有一个 `{{soul_section}}` 占位符。
但如果用户没有写 `SOUL.md`，渲染出来就是一个空字符串。

如果模板里没有写这个占位符，但用户的目录里又有 `SOUL.md` 怎么办？

```typescript
const hasSoulPlaceholder = SOUL_PLACEHOLDER.test(template)
// ...
if (!hasSoulPlaceholder && soulSection) {
    prompt = `${prompt}\n\n${soulSection}`
}
```

这段逻辑实现了**优雅降级**：
- 如果模板里明确了位置 (`{{soul_section}}`)，就在那插
- 如果没写占位符，就默认追加到末尾

---

## 第四部分：组装管线 — loadSystemPrompt

> 对应源码：[prompt.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/runtime/prompt.ts) 后半部分

### 4.1 核心流程

`loadSystemPrompt` 是暴露给外部的主入口。它的结构非常清晰的流程式代码：

```typescript
export async function loadSystemPrompt(options = {}) {
    const cwd = options.cwd ?? process.cwd()

    // 1. 读模板
    const promptPath = join(moduleDir, 'prompt.md')
    const template = await readFile(promptPath, 'utf-8')

    // 2. 读用户级配置
    const soul = await readSoulMd()
    const soulSection = soul ? renderSoulSection(soul) : ''

    // 3. 基础变量渲染
    let prompt = renderTemplate(template, {
        date: new Date().toISOString(),
        user: resolveUsername(),
        pwd: cwd,
        soul_section: soulSection,
    })

    // 4. Fallback 追加 SOUL
    if (!hasSoulPlaceholder && soulSection) { ... }

    // 5. 追加项目级配置
    const agents = await readProjectAgentsMd(cwd)
    if (agents) {
        prompt = `${prompt}\n\n## Project AGENTS.md\n...`
    }

    return prompt
}
```

### 4.2 为什么导出 `LoadSystemPromptOptions` 参数？

```typescript
export type LoadSystemPromptOptions = {
    cwd?: string
}
```

在测试环境（Test runner）中，`process.cwd()` 可能指向的是项目根目录（运行测试的地方），而不是模拟的工作目录。
传递 `cwd` 允许调用方指定"当前工作目录到底在哪"，方便写测试和处理 multi-workspace 场景。

---

## 第五部分：入口集成

> 对应源码：[index.ts](file:///d:/For%20coding/project/Agents/example/cclin/src/index.ts) 的修改

### 5.1 从同步到异步的转变

之前：
```typescript
const session = new Session({
    systemPrompt: '硬编码字符串'
})
```

现在：
```typescript
const systemPrompt = await loadSystemPrompt({ cwd: process.cwd() })
const session = new Session({ systemPrompt, ... })
```

因为 `readFile` 是异步的，所以需要在顶层使用 `await`。
在 Node.js 中，如果模块不是原生 ESM（或者配置不支持顶层 await），需要用 **Async IIFE** (Immediately Invoked Function Expression) 包裹：

```typescript
// 使用分号开头，防止之前的代码没有写分号导致解析错误
;(async () => {
    // ... 原来的启动逻辑
    const systemPrompt = await loadSystemPrompt()
    // ...
})().catch((err) => {
    console.error(`❌ Startup failed: ${(err as Error).message}`)
    process.exit(1)
})
```

这样既解决了异步问题，又增加了顶层错误捕获。

---

## 第六部分：总结

### 设计原则回顾

| 原则 | 在 Phase 5 中的体现 |
|------|---------------------|
| **KISS（保持简单）** | 没用复杂的第三方模板引擎，只用了一个简单的正则替换。 |
| **关注点分离** | 模板文件（.md）、渲染逻辑（引擎）、数据源（AGENTS/SOUL）互相解耦。 |
| **优雅降级** | 模板里没占位符也能自动追加配置内容。不强迫用户修改模板。 |
| **依赖注入** | 通过 `cwd` 参数代替写死的 `process.cwd()`，提升可测试性。 |

### 数据流图

```
                [prompt.md] (通用模板)
                     +
                { date, user, pwd }
                     ↓
             renderTemplate()
                     ↓
                [SOUL.md] (用户偏好层)
                     ↓
              [AGENTS.md] (项目配置层)
                     ↓
               loadSystemPrompt()
                     ↓
           Session(systemPrompt: string)
                     ↓
              ReAct 主循环
```

**下一步**：当前系统已经能较好地工作，但长对话会撑爆 Token 限制。
Phase 6 将实现**上下文压缩（Context Compaction）**，在 Tokens 达到阈值时自动生成摘要重构历史。

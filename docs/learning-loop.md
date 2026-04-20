# cclin 学习闭环功能实现讲解

> 目标：让 Agent 能跨会话成长 —— 记住用户偏好、回忆历史解法。
> 本文档讲解三个功能层次的具体实现原理。

---

## 一、整体架构图

```
用户输入
  │
  ▼
Session.runTurn()
  ├─ historySink.append(turn_start)   ← 写入用户输入
  ├─ ReAct 循环（LLM + 工具调用）
  └─ historySink.append(final)        ← 写入 assistant 最终回答
          │
          ▼
  ~/.cclin/history/YYYY-MM-DD.jsonl   ← 持久化 JSONL 文件

工具调用树（Agent 可主动调用）：
  get_memory("notes")   → 读 ~/.cclin/memories/notes.md
  remember_note         → 写 ~/.cclin/memories/notes.md
  get_memory("project") → 读 CWD/AGENTS.md
  search_history        → 扫描 ~/.cclin/history/*.jsonl
  create_skill          → 写 ~/.cclin/skills/<name>/SKILL.md
```

---

## 二、Level 1：Memory 读写（跨会话记忆）

### 核心思路

`AGENTS.md` 是项目级记忆（已有），但它是静态文件，Agent 无法自主写入。
新增两个工具，实现**用户偏好 / 解法**的自由读写：

- `get_memory("notes")` — 读取跨会话笔记
- `remember_note` — 追加跨会话笔记

存储位置：`~/.cclin/memories/notes.md`（Markdown 纯文本，人类可直接编辑）。

### 关键实现

#### 1. `src/tools/get-memory.ts` — 扩展了 notes 类型

原来只支持 `"project"`（读 CWD/AGENTS.md），现在新增 `"notes"`：

```typescript
// 按 memory_id 决定读哪个文件
if (memoryId === 'project') {
    resolved = path.resolve('AGENTS.md')          // 项目级，相对 CWD
} else {
    // notes → ~/.cclin/memories/notes.md
    resolved = path.join(getCclinHome(), 'memories', 'notes.md')
}

// notes 不存在时返回友好提示，而非报错
if (memoryId === 'notes') {
    return { output: JSON.stringify({ memory_summary: '(no notes saved yet)' }) }
}
```

**设计要点**：`notes` 文件不存在时不报错，这样 Agent 首次读取也能正常工作。

#### 2. `src/tools/remember-note.ts` — 新建工具

```typescript
// 工具签名
name: 'remember_note'
input: { content: string; category?: string }
```

写入逻辑：

```typescript
// 1. 确保目录存在（recursive: true，不需要预先创建）
await fs.mkdir(path.dirname(notesPath), { recursive: true })

// 2. 追加格式化条目
const date = new Date().toISOString().split('T')[0]  // YYYY-MM-DD
const header = category ? `[${date}] (${category})` : `[${date}]`
const entry = `\n---\n${header}\n${content}\n`

await fs.appendFile(notesPath, entry, 'utf-8')
```

生成的 `notes.md` 示例：

```markdown
---
[2026-04-20] (convention)
项目使用 ESM 导入风格（import/export），不使用 require

---
[2026-04-20] (preference)
代码注释保持英文，commit message 也用英文
```

#### 3. `src/runtime/prompt.md` — 添加 Memory 使用指导

告诉 Agent：
- **什么时候读**：用户提到偏好/历史方案时，先 `get_memory("notes")`
- **什么时候写**：用户说「记住这个」、或解决了可能复现的复杂问题

---

## 三、Level 2A：会话历史搜索（grep 版）

### 核心思路

历史记录每行是一个 JSON 对象（JSONL 格式），Agent 可以通过 `search_history` 在所有历史文件里做关键字搜索，找到过去的解法。

### 关键实现

#### 1. `src/tools/search-history.ts` — 新建工具

```typescript
name: 'search_history'
input: { query: string; limit?: number }
```

搜索逻辑：

```typescript
// 1. 列出 ~/.cclin/history/*.jsonl 所有文件
const files = (await fs.readdir(historyDir))
    .filter(f => f.endsWith('.jsonl'))

// 2. 逐行 JSON.parse，只保留 type === 'final' 的条目
//    （assistant 最终回答，过滤掉工具调用噪声）
if (event.type !== 'final') continue
if (!event.content) continue

// 3. 大小写不敏感关键字匹配
if (!event.content.toLowerCase().includes(queryLower)) continue

// 4. 收集命中结果，按时间倒序返回 limit 条（默认 10）
matches.sort((a, b) => b.ts.localeCompare(a.ts))
```

**为什么只搜 `final`**：历史里还有 `turn_start`（用户输入）、`action`（工具调用）等事件，但用户最关心的是「Agent 给出的最终答案」，所以只取 `final` 类型，结果更干净。

**为什么用倒序**：最近的解法通常最有参考价值。

#### 输出示例

```
Found 2 result(s) for "circular dependency" (showing top 2):

--- Result 1 ---
[2026-04-20 13:52] session=abc12345 (2026-04-20.jsonl)
解决循环依赖的方法是使用惰性代理模式……

--- Result 2 ---
[2026-04-19 09:30] session=def67890 (2026-04-19.jsonl)
可以用 closure 持有变量引用，然后在 useEffect 里延迟赋值……
```

---

## 四、historySink 接入（让历史真正落地）

### 核心问题

`history.ts` 里的 `JsonlHistorySink` 和 `session.ts` 里的写入逻辑都已完整实现，但 `index.ts` 创建 `Session` 时没有传 `historySink`，导致历史文件从未生成。

### 接入方案

在 `src/index.ts` 的 `handleMiddlewareReady` 回调里（TUI 就绪、Session 即将创建的时机）：

```typescript
const handleMiddlewareReady = (mw: AgentMiddleware) => {
    // 1. 每次启动创建新历史文件，按日期归档
    const cclinHome = process.env.CCLIN_HOME ?? path.join(os.homedir(), '.cclin')
    const today = new Date().toISOString().slice(0, 10)  // YYYY-MM-DD
    const historyFile = path.join(cclinHome, 'history', `${today}.jsonl`)
    historySink = new JsonlHistorySink(historyFile)

    // 2. 传给 Session
    session = new Session({
        ...
        historySink: historySink ?? undefined,
    })
}
```

退出时关闭（确保剩余写入刷盘）：

```typescript
const handleExit = () => {
    tokenCounter.dispose()
    router.dispose().catch(() => {})
    historySink?.close().catch(() => {})  // 新增
}
```

### 写入时序

```
用户输入 → session.runTurn(input)
              │
              ├─ historySink.append({ type: 'turn_start', content: input })
              │
              │  【ReAct 循环执行中...】
              │
              └─ historySink.append({
                     type: 'final',
                     content: result.finalText,
                     meta: { status, steps, tokenUsage }
                 })
```

### 文件命名策略

选择**按日期命名**（`YYYY-MM-DD.jsonl`）而非按 sessionId：

- 好处：同一天的多个会话追加到同一文件，便于按天回顾
- 多个会话用 `sessionId` 字段区分（UUID 的前 8 位已足够辨识）
- 文件数量随使用时间线性增长，不会爆炸

---

## 五、Level 3：Skill 自我学习

### 核心思路

`notes.md` 适合记录简短的偏好和技巧，但对于**复杂的、多步骤的解法**，更好的形式是 Skill：
带格式的 Markdown 文档，下次启动时自动注入为 System Prompt 的一部分，
Agent 看到任务描述就能主动调用。

`create_skill` 工具让 Agent 把当前会话中的解法整理成 SKILL.md 并保存，
无需人工干预。

### Skill 文件格式

与现有 `skills.ts` 的 `parseSkillFile()` 完全兼容，必须带 YAML frontmatter：

```markdown
---
name: ts-circular-dep
description: 解决 TypeScript 项目中模块间循环依赖问题的步骤
---

## 问题场景

A 模块 import B，B 模块 import A，导致其中一个在运行时为 undefined。

## 解决步骤

1. 用惰性代理模式：先声明变量，闭包持有引用，初始化后再赋值
2. 将共用类型提取到独立的 `types.ts`，断开实现层的循环
3. 使用 `--traceResolution` 验证实际加载顺序
```

### 关键实现

#### 1. `src/tools/create-skill.ts` — 新建工具

```typescript
name: 'create_skill'
input: { name: string; description: string; instructions: string }
```

**name sanitize 逻辑**：将用户输入的名字转为安全的目录名：

```typescript
function sanitizeName(name: string): string {
    return name
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')           // 空格 → 连字符
        .replace(/[^a-z0-9\-_]/g, '')  // 移除非法字符
        .replace(/^-+|-+$/g, '')        // 去掉首尾连字符
}
// "Fix TS Circular Dep!" → "fix-ts-circular-dep"
```

**写入逻辑**：

```typescript
// 目标路径：~/.cclin/skills/<safeName>/SKILL.md
const skillDir = path.join(getCclinHome(), 'skills', safeName)

// 构造带 frontmatter 的 Markdown
const content = [
    '---',
    `name: ${safeName}`,
    `description: ${description}`,
    '---',
    '',
    instructions,
].join('\n')

await fs.mkdir(skillDir, { recursive: true })
await fs.writeFile(skillFile, content, 'utf-8')
```

**已存在时覆盖并提示**，不静默失败。

#### 2. 为什么保存到 `~/.cclin/skills/` 就能被自动发现？

`skills.ts` 的 `resolveSkillRoots()` 扫描两个目录：

```typescript
return [
    join(cwd, '.agents', 'skills'),  // 项目级
    join(cclinHome, 'skills'),        // 用户级 ← create_skill 写这里
]
```

`loadSkills()` 在每次 `pnpm start` 时调用，结果注入 system prompt。
所以 `create_skill` 写入后，**下次会话启动就自动出现在 Available Skills 列表**，
Agent 看到描述匹配的任务时会主动 `read_file` 读取 SKILL.md 并执行指令。

#### 3. 触发时机设计（prompt.md 里的指导）

```
用户说："把刚才的方法记成 skill"
  → Agent 调用 create_skill，整理 name / description / instructions
  → 写入 ~/.cclin/skills/<name>/SKILL.md
  → 通知用户：下次会话自动生效
```

**主动创建 vs. 按需创建**：
- 建议先实现用户主动触发（当前实现）
- 未来可在会话结束时让 Agent 自行评估是否值得保存为 Skill（需提示词多轮调优）

#### 4. `remember_note` vs `create_skill` 的选择

| | `remember_note` | `create_skill` |
|---|---|---|
| 适用场景 | 简短偏好、项目约定 | 复杂多步骤、可跨项目复用的解法 |
| 存储格式 | `notes.md` 追加条目 | 独立 `SKILL.md` 文件 |
| 下次生效方式 | Agent 主动调用 `get_memory` | 自动注入 system prompt |
| 粒度 | 细粒度（一句话） | 粗粒度（完整指令文档） |

---

## 六、数据流全景

```
pnpm start
  │
  ├─ handleMiddlewareReady()
  │    └─ 创建 JsonlHistorySink → ~/.cclin/history/2026-04-20.jsonl
  │
  │  用户输入："记住我用 ESM 导入"
  │
  ├─ session.runTurn()
  │    ├─ 写 turn_start 事件
  │    ├─ ReAct: LLM 决定调用 remember_note
  │    │    └─ 追加 ~/.cclin/memories/notes.md
  │    └─ 写 final 事件（"已记录：..."）
  │
  │  用户输入："搜一下我们以前怎么处理循环依赖的"
  │
  ├─ session.runTurn()
  │    ├─ 写 turn_start 事件
  │    ├─ ReAct: LLM 调用 search_history("circular dependency")
  │    │    └─ 扫描 ~/.cclin/history/*.jsonl，返回匹配结果
  │    └─ 写 final 事件（Agent 引用历史方案的回答）
  │
  │  用户输入："把刚才解决循环依赖的方法记成 skill"
  │
  ├─ session.runTurn()
  │    ├─ 写 turn_start 事件
  │    ├─ ReAct: LLM 调用 create_skill(...)
  │    │    └─ 写 ~/.cclin/skills/ts-circular-dep/SKILL.md
  │    └─ 写 final 事件（"已保存，下次会话自动生效"）
  │
  └─ Ctrl+C → handleExit() → historySink.close()
```

---

## 六、文件结构总览

```
src/
  tools/
    get-memory.ts      ← 扩展了 "notes" 类型
    remember-note.ts   ← 新建，追加跨会话笔记
    search-history.ts  ← 新建，grep 扫描历史 JSONL
    create-skill.ts    ← 新建，将解法保存为 Skill
  runtime/
    history.ts         ← 已有，JsonlHistorySink 实现
    skills.ts          ← 已有，Skill 发现与注入（兼容新写入格式）
    prompt.md          ← 新增 Memory Usage + Skill 创建时机指导区块
  index.ts             ← 接入 historySink，注册所有新工具

~/.cclin/              （运行时数据，CCLIN_HOME 可重定向）
  memories/
    notes.md           ← 跨会话笔记（remember_note 写入）
  history/
    2026-04-20.jsonl   ← 今日历史（turn_start + final 事件）
    2026-04-19.jsonl   ← 昨日历史
  skills/
    ts-circular-dep/
      SKILL.md         ← create_skill 写入，下次启动自动注入
    fix-build-error/
      SKILL.md
```

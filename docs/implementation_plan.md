# cclin 学习闭环功能实现计划

让 Agent 真正跨会话成长：Memory 系统 + 历史搜索 + Skill 自我学习

## 背景

hermes-agent（ https://github.com/NousResearch/hermes-agent ） 的"学习闭环/自我进化"本质是**外置记忆的积累**，不是模型权重更新。
三个功能层次互相独立、逐层叠加，每一层独立可用。

当前 cclin 状态：
- ✅ Skill 发现与注入（`runtime/skills.ts`）已完整实现
- ✅ 会话历史 JSONL 持久化（`runtime/history.ts`）已完整实现
- ⚠️ `get_memory` 工具仅支持读 `AGENTS.md`，不支持自由 notes
- ❌ Memory 写入工具缺失
- ❌ 历史搜索工具缺失
- ❌ Skill 自我创建工具缺失

---

## Level 1：Memory 读写（最小闭环）

**价值**：Agent 能跨会话记住用户偏好、项目背景、解决过的问题。

**预计工作量**：半天（约 80 行代码）

### 涉及文件

#### [MODIFY] get-memory.ts
- `MEMORY_FILES` 映射中新增 `notes` 键，指向 `~/.cclin/memories/notes.md`
- 读取路径改用 `getCclinHome()` 辅助函数，支持 `CCLIN_HOME` 环境变量

#### [NEW] remember-note.ts
新建工具 `remember_note`：

```typescript
// 工具签名
name: 'remember_note'
input: { content: string; category?: string }

// 执行逻辑
// 1. 解析 ~CCLIN_HOME~/memories/notes.md（不存在则创建）
// 2. 在文件末尾追加：
//    ---
//    [2026-04-20] (category)
//    content
// 3. 返回确认消息
```

#### [MODIFY] index.ts（入口文件）
- 注册 `rememberNoteTool` 到 `ToolRegistry`

#### [MODIFY] runtime/prompt.md
- 在 `# Reminders` 区块添加 Memory 使用说明：何时应该主动记录笔记

### 目录结构

```
~/.cclin/
  memories/
    notes.md          ← 跨会话记忆文件（自动创建）
  skills/             ← 已有
```

### 验证方式
1. 对 Agent 说："记住我的项目使用 ESM 导入风格"
2. 结束会话，重新启动
3. 新会话中问 Agent："我的项目用什么导入风格？"
4. Agent 调用 `get_memory("notes")` 并回答正确

---

## Level 2：会话历史搜索

**价值**：Agent 能回忆"上次我们怎么解决类似问题"。

**预计工作量**：简版（grep）1 小时 | SQLite 版本 2-3 天

**建议先实现简版，按需升级。**

### 方案 A：行级 grep（推荐先做）

#### [NEW] tools/search-history.ts

```typescript
name: 'search_history'
input: { query: string; limit?: number }

// 执行逻辑
// 1. 扫描 ~/.cclin/history/*.jsonl
// 2. 逐行 JSON.parse，检查 content 字段是否包含 query
// 3. 只返回 type === 'final' 的条目（assistant 回复）
// 4. 按时间倒序，最多返回 limit（默认 10）条
```

#### [MODIFY] index.ts
- 注册 `searchHistoryTool`

### 方案 B：SQLite FTS5（未来升级）

> [!NOTE]
> 需要安装 `better-sqlite3`（native addon，Windows 需要 node-gyp）。
> 建议在方案 A 验证需求后再实施。

#### [NEW] runtime/search-db.ts
- 建表：`CREATE VIRTUAL TABLE history_fts USING fts5(session_id, ts, type, content)`
- 写入：在 `JsonlHistorySink.append()` 同步写入 SQLite
- 查询：`SELECT * FROM history_fts WHERE history_fts MATCH ?`

#### [MODIFY] runtime/history.ts
- `JsonlHistorySink` 接受可选 `SearchDB` 参数，写入时双写

### 验证方式
1. 对 Agent 描述一个问题，获得解决方案
2. 新会话中说："搜一下我们以前讨论过 XXX 问题的解法"
3. Agent 调用 `search_history("XXX")`，找到并引用历史方案

---

## Level 3：Skill 自我学习

**价值**：把当前对话中的解法整理成可复用的 Skill，下次自动应用。

**预计工作量**：工具实现 2 小时，提示词调优需迭代

### 涉及文件

#### [NEW] tools/create-skill.ts

```typescript
name: 'create_skill'
input: {
    name: string        // Skill 名称
    description: string // 一句话描述（用于匹配触发）
    instructions: string // Skill 正文（Markdown）
}

// 执行逻辑
// 1. 目标路径：~/.cclin/skills/<name>/SKILL.md
// 2. 写入带 frontmatter 的 Markdown：
//    ---
//    name: <name>
//    description: <description>
//    ---
//    <instructions>
// 3. 返回文件路径确认
```

#### [MODIFY] index.ts
- 注册 `createSkillTool`

#### [MODIFY] runtime/prompt.md
- 新增 Skill 创建时机指导：
  - 用户明确要求保存为 Skill
  - 解决了一个复杂的、可能重复出现的问题
  - 发现了特定项目的固定模式

### 触发时机设计

两种模式：

**用户主动触发**（简单，先实现）：
```
用户说："把刚才的方法记成一个 skill"
→ Agent 调用 create_skill 整理并保存
```

**Agent 自动提炼**（复杂，后续迭代）：
```
会话结束时，Agent 评估是否产生了值得保存的知识
→ 如果是，自动调用 create_skill
```

### 验证方式
1. 解决一个复杂问题后说："把这个方案记成 skill，名字叫 fix-ts-circular-dep"
2. 检查 `~/.cclin/skills/fix-ts-circular-dep/SKILL.md` 是否创建
3. 新会话中遇到类似问题，Agent 应在 System Prompt 的 Skills 列表中看到该 Skill，并调用 `read_file` 阅读它

---

## 实施路线图

```
Week 1:
  Day 1  ── Level 1: remember_note + get_memory 升级     [半天]
  Day 1  ── Level 2A: search_history grep 版             [半天]

Week 1-2:
  Day 2-3 ── Level 3: create_skill + 提示词调优          [1-2天]

按需:
  Level 2B: SQLite FTS5 升级（性能需求出现后再做）
```

## 开放问题

> [!IMPORTANT]
> **notes.md 的上下文注入时机**：每次会话都全量注入 notes.md，还是 Agent 需要时再调用 `get_memory("notes")`？全量注入占用 token，按需调用可能遗漏。建议先按需调用，等遇到实际问题再调整。

> [!NOTE]
> **Skill 创建的粒度**：太细则 Skill 爆炸（每个小技巧都存一个），太粗则描述不精确导致触发率低。hermes-agent 的做法是让 LLM 自己判断，但需要提示词多轮调优。Level 3 的"自动提炼"功能建议后期迭代。

# cclin 架构升级学习笔记

> 实现日期：2026-04-20  
> 涉及模式：中央 Slash 命令注册表 + 并行工具执行策略  
> 灵感来源：NousResearch/hermes-agent（103k ⭐）

---

## 一、中央 Slash 命令注册表

### 1.1 解决了什么问题

改之前，`/compact`、`/clear`、`/exit` 等命令的信息**散落在两个文件里**：

```
input.tsx   ─── SLASH_COMMANDS 数组（补全列表）
app.tsx     ─── handleSubmit 里的 if/else 字符串匹配（路由逻辑）
```

这带来两个痛点：
1. **添加命令要改两处**：补全列表加一条、路由逻辑加一个 `if`，容易漏
2. **"有哪些命令"没有唯一真相**：补全列表和实际处理可以不一致

### 1.2 新增文件：`src/tui/commands.ts`

这是所有命令的**唯一数据源**。添加命令只需在此文件的数组里追加一条记录。

```typescript
// 核心数据结构
export interface CommandDef {
    name: string      // 规范名称，不含斜杠（如 "compact"）
    slash: string     // 带斜杠的完整名称（如 "/compact"）
    desc: string      // 用户可见的描述
    category: CommandCategory
    aliases?: readonly string[]  // 别名列表
    argsHint?: string            // 参数占位符
}

export const COMMAND_REGISTRY: readonly CommandDef[] = [
    // 在这里添加新命令 ↓
    { name: 'compact', slash: '/compact', desc: '...', category: 'session' },
    { name: 'exit', slash: '/exit', desc: '...', category: 'info', aliases: ['quit', 'q'] },
    // ...
]
```

### 1.3 派生数据结构（自动更新）

`commands.ts` 在模块初始化时从 `COMMAND_REGISTRY` **自动生成**三个消费数据：

| 导出名 | 用途 | 消费者 |
|--------|------|--------|
| `COMPLETION_CANDIDATES` | Tab 补全候选列表 | `input.tsx` |
| `COMMAND_MAP` | 规范名/别名 -> CommandDef 映射 | `resolveCommand()` |
| `resolveCommand(raw)` | 解析用户输入字符串 | `app.tsx` |

**关键实现**：`COMMAND_MAP` 是模块级常量，在 import 时就执行了计算（IIFE 模式）：

```typescript
export const COMMAND_MAP: ReadonlyMap<string, CommandDef> = (() => {
    const map = new Map<string, CommandDef>()
    for (const cmd of COMMAND_REGISTRY) {
        map.set(cmd.name, cmd)             // 规范名 → def
        for (const alias of cmd.aliases ?? []) {
            map.set(alias, cmd)            // 每个别名 → 同一个 def
        }
    }
    return map
})()
```

### 1.4 修改的文件

**`src/tui/input.tsx`（Tab 补全）**：

```diff
- const SLASH_COMMANDS = [
-     { name: '/compact', desc: 'Compact context history' },
-     ...
- ] as const
+ import { COMPLETION_CANDIDATES } from './commands.js'

  const slashSuggestions = useMemo(() => {
-     return SLASH_COMMANDS.filter(c => c.name.startsWith(editor.value))
+     return COMPLETION_CANDIDATES.filter(c => c.slash.startsWith(editor.value))
  }, [editor.value])
```

**`src/tui/app.tsx`（命令路由）**：

```diff
+ import { resolveCommand } from './commands.js'

  const handleSubmit = useCallback(async (input, attachments) => {
-     if (input.trim() === '/clear') {
-         console.clear()
-         dispatch({ type: 'clear_all' })
-     }
+     const cmd = resolveCommand(input.trim())
+     if (cmd) {
+         if (cmd.name === 'exit') { onExit(); exit(); return }
+         if (cmd.name === 'clear') { console.clear(); dispatch({ type: 'clear_all' }); return }
+         // 其他 slash 命令：继续发给 LLM 处理
+     }
  }, [...])
```

`resolveCommand` 支持大小写不敏感、有无斜杠、别名解析：`/Q`、`/quit`、`/exit` 都能找到 exit 命令。

### 1.5 如何添加新命令（操作指南）

**只需修改一个文件** `src/tui/commands.ts`：

```typescript
// 在 COMMAND_REGISTRY 追加
{
    name: 'history',
    slash: '/history',
    desc: 'Show conversation history',
    category: 'session',
    aliases: ['hist'],
}
```

然后在 `app.tsx` 的 `handleSubmit` 加对应处理：

```typescript
if (cmd.name === 'history') {
    dispatch({ type: 'show_history' })
    return
}
```

补全列表、别名解析、帮助显示全部自动更新，不需要触碰其他文件。

---

## 二、并行工具执行策略

### 2.1 解决了什么问题

改之前，`ToolOrchestrator.executeActions()` 是这样的：

```typescript
for (const action of actions) {
    const result = await this.executeAction(action, hooks) // 一个等完才执行下一个
    results.push(result)
}
```

当 LLM 在同一轮次请求多个工具时（比如同时读 3 个文件），执行时间是**累加**的：

```
read_file("a.md")   → 10ms
read_file("b.md")   → 10ms   ← 等 a.md 先跑完
read_file("c.md")   → 10ms   ← 等 b.md 先跑完
合计：~30ms
```

改后，只读工具并行执行，总时间 = 最慢的那个：~10ms。

### 2.2 并行安全的核心难题

难点不是"怎么并发"（`Promise.all` 就够了），而是**哪些工具并发是安全的**：

- 两个 `read_file` 同时跑：安全，不互相干扰
- 两个 `write_file` 同时写同一个文件：**危险**，可能产生写竞态
- `spawn_agent` 和 `send_input` 并行：**语义错误**，需要保证顺序

### 2.3 三级分类系统

新增在 `src/tools/orchestrator.ts`：

```typescript
// 第一级：永远可以并行（只读 / 幂等工具）
const PARALLEL_SAFE_TOOLS = new Set([
    'read_file',
    'list_directory',
    'search_files',
    'get_memory',
    'bash',   // 本身安全；破坏性命令由 safety.ts 额外拦截
])

// 第二级：永远不并行（有交互副作用）
const NEVER_PARALLEL_TOOLS = new Set([
    'spawn_agent',   // 子 Agent 启动，占用大量资源
    'send_input',    // 子 Agent 交互，需要序求保证
    'close_agent',   // 子 Agent 生命周期操作
    'wait_agent',    // 等待子 Agent，串行语义
])
```

第三级由工具本身的 `isMutating` 字段决定（已有字段，免额外维护）。

### 2.4 判断函数 `shouldParallelize`

```typescript
function shouldParallelize(actions: ToolAction[], registry: ToolQueryable): boolean {
    if (actions.length <= 1) return false        // 单个工具，并行无意义

    const names = actions.map(a => a.name)

    if (names.some(n => NEVER_PARALLEL_TOOLS.has(n))) return false  // 黑名单

    for (const name of names) {
        const tool = registry.get(name)
        if (tool?.isMutating) return false       // 任何写副作用工具 → 串行
    }

    if (names.every(n => PARALLEL_SAFE_TOOLS.has(n))) return true   // 全部安全

    return false                                 // 其他：保守串行
}
```

### 2.5 升级后的 `executeActions`（双路径）

```typescript
async executeActions(actions, hooks) {
    if (shouldParallelize(actions, this.registry)) {
        // 并行路径：总时间 = 最慢工具
        const results = await Promise.all(
            actions.map(action => this.executeAction(action, hooks))
        )
        return { results, combinedObservation: ..., hasRejection: ... }
    }

    // 串行路径：遇到 approval_denied 时提前中断
    const results: ToolActionResult[] = []
    for (const action of actions) {
        const result = await this.executeAction(action, hooks)
        results.push(result)
        if (result.status === 'approval_denied') break
    }
    return { results, combinedObservation: ..., hasRejection: ... }
}
```

### 2.6 如何添加新工具并设置并行策略（操作指南）

注册工具时（在各 `tools/*.ts` 文件里）：

```typescript
// 只读工具 → 设 isMutating: false，并在 PARALLEL_SAFE_TOOLS 里加名字
export const readFileTool: ToolDefinition = {
    name: 'read_file',
    isMutating: false,  // 关键标记
    // ...
}

// 写工具 → 设 isMutating: true，shouldParallelize 会自动拒绝并行
export const writeFileTool: ToolDefinition = {
    name: 'write_file',
    isMutating: true,   // 关键标记
    // ...
}
```

---

## 三、总结：核心思想对比

| 设计 | 核心思想 | 技术实现 |
|------|---------|---------|
| 中央命令注册表 | 单一数据源，所有消费者从此派生 | `COMMAND_REGISTRY` 数组 + IIFE 生成 Map |
| 并行工具执行 | 安全默认串行，明确声明安全则并行 | 三级分类 + `Promise.all` / `for...of` 双路径 |

两者共同体现了一个原则：**改一处，处处生效；而非改处处，不知漏哪**。

---

## 四、改动文件清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/tui/commands.ts` | 新建 | 中央 slash 命令注册表（唯一数据源） |
| `src/tui/input.tsx` | 修改 | 补全列表改从注册表导入 |
| `src/tui/app.tsx` | 修改 | 命令路由使用 `resolveCommand` |
| `src/tools/orchestrator.ts` | 修改 | 添加并行安全分类 + 双路径执行 |

# 实战学习：对齐 memo-code 已有能力

> 📅 2026-03-29 | Phase 10 四个功能批次
> 本文记录如何将 cclin 补齐到 memo-code 的能力水平：分析差距、逐个实现、集成验证。

---

## 前置：差距分析（怎么知道缺什么？）

**思考过程**：不是拍脑袋列清单，而是实际去读 memo-code 的代码：

```
memo-code/packages/tools/src/tools/  → 所有工具文件
memo-code/packages/core/src/runtime/ → 运行时能力
```

逐个文件对比 cclin 已有能力，找出缺失项：

| memo-code 文件 | 功能 | cclin 状态 |
|---------------|------|-----------|
| `get_memory.ts` | 读取 AGENTS.md | ❌ 缺失 |
| `search_files.ts` | glob 搜索文件 | ❌ 缺失 |
| `update_plan.ts` | 计划文件 | ✅ 已实现 |
| `model_profile.ts` | 模型能力检测 | ❌ 缺失 |
| `history.ts` | JSONL 持久化 | ❌ 缺失 |
| `collab.ts` | 多 Agent 协作 | ❌ 高级功能，暂不做 |
| `skills.ts` | 技能系统 | ❌ 高级功能，暂不做 |

> **教训**：对齐能力前，先做完整的功能对照表。按复杂度排序，简单的先做。

---

## Batch 1：`get_memory` 工具

### 思考：memo-code 的 get_memory 做了什么？

读源码发现它异常简单：
1. 接收 `memory_id` 参数
2. 读取 `~/.memo/Agents.md` 文件
3. 返回 JSON 格式的内容

**我的设计选择**：
- memo-code 硬编码读 `~/.memo/Agents.md`（全局），我改为读 **当前工作目录** 的 `AGENTS.md`（项目级）
- 用 `MEMORY_FILES` 映射表替代硬编码，未来可扩展更多 memory_id

### 关键代码片段

```typescript
// 映射表设计：一个 memory_id 对应一个文件
const MEMORY_FILES: Record<string, string> = {
    project: 'AGENTS.md',  // 可以扩展更多
}

// execute 中的查找逻辑
const filename = MEMORY_FILES[memoryId]
if (!filename) {
    // 提供帮助信息：告诉 LLM 支持哪些 ID
    const supported = Object.keys(MEMORY_FILES).join(', ')
    return { output: `Error: unknown memory_id. Supported: ${supported}` }
}
```

**为什么不直接硬编码文件名？**
→ 当未来需要支持 `"user_preferences"` 或 `"session_notes"` 等新 memory_id 时，只需往映射表加一行。

---

## Batch 2：`search_files` 工具

### 思考：Agent 需要什么样的搜索？

memo-code 用了独立的 `searchFilesWithValidation` 库函数。cclin 不需要这么重的依赖，但核心需求是相同的：
1. 给定一个目录和 glob 模式（如 `*.ts`）
2. 递归搜索匹配的文件名
3. 自动排除 `node_modules`、`.git` 等噪音

### 三个设计决策

**决策 1：不引入 glob 库，自己写简单匹配**

```typescript
function matchGlob(filename: string, pattern: string): boolean {
    // 把 glob 的 * 转成正则的 .*
    const regex = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // 转义特殊字符
        .replace(/\*/g, '.*')                   // * → .*
    return new RegExp(`^${regex}$`, 'i').test(filename)
}
```

→ 这只支持 `*` 通配符，不支持 `**` 或 `?`。对 Agent 场景够用了。

**决策 2：默认排除列表**

```typescript
const DEFAULT_EXCLUDES = new Set([
    'node_modules', '.git', 'dist', '.next',
    '__pycache__', '.venv', 'coverage',
])
```

→ 用 `Set` 而不是数组，因为每个目录项都要查一次，O(1) vs O(n)。

**决策 3：结果上限 100 条**

→ 防止 Agent 搜索根目录导致输出爆炸。搜到 100 条就停止遍历。

### 遇到的类型问题

`fs.readdir({ withFileTypes: true })` 在新版 Node 类型中返回 `Dirent<NonSharedBuffer>`，
而我们需要 `Dirent`（string 类型）。解法：

```typescript
entries = await fs.readdir(dir, {
    withFileTypes: true,
    encoding: 'utf-8',  // 显式指定编码
}) as import('node:fs').Dirent[]
```

---

## Batch 3：Model Profile

### 思考：为什么需要模型配置？

不同模型能力不同：

| 模型 | 并行工具调用 | 思考链 | 上下文窗口 |
|------|:----------:|:-----:|:---------:|
| gpt-4o | ✅ | ❌ | 128K |
| deepseek-chat | ❌ | ❌ | 64K |
| deepseek-reasoner | ❌ | ✅ | 64K |
| claude | ✅ | ❌ | 200K |

之前 `client.ts` 硬编码发送请求，不管模型是否支持 `parallel_tool_calls`。

### 实现：最长前缀匹配策略

```typescript
// 用户可能传 "gpt-4o-2024-08-06"，需要匹配到 "gpt-4o"
function resolveModelProfile(model: string): ModelProfile {
    const slug = model.trim().toLowerCase()

    // 1. 精确匹配
    if (KNOWN_PROFILES[slug]) return { ...KNOWN_PROFILES[slug] }

    // 2. 前缀匹配（取最长匹配）
    let bestKey = ''
    for (const key of Object.keys(KNOWN_PROFILES)) {
        if (slug.startsWith(key) && key.length > bestKey.length) {
            bestKey = key
        }
    }
    // ...
}
```

**为什么取最长前缀？**
→ `gpt-4o-mini-2024-07-18` 同时匹配 `gpt-4o` 和 `gpt-4o-mini`，应该取 `gpt-4o-mini`。

### 集成到 client.ts

改动最小化——只改 API 调用那一处：

```diff
-const data = await client.chat.completions.create({
-    model: config.model,
-    messages: openAIMessages,
-    ...(config.tools ? { tools: config.tools } : {}),
-})
+const profile = resolveModelProfile(config.model)
+const requestParams = buildChatCompletionRequest({
+    model: config.model, messages: openAIMessages,
+    tools: config.tools, profile,
+})
+const data = await client.chat.completions.create({
+    ...requestParams, stream: false,
+})
```

**注意 `stream: false`**：不加这个，TypeScript 推断返回类型为 `Stream | Completion` 联合体，导致 `.choices` 报错。

---

## Batch 4：JSONL History（会话持久化）

### 思考：为什么用 JSONL 而不是 JSON？

- **JSON**：整个文件是一个数组，每次写入要读旧内容 → 修改 → 写回。并发不安全。
- **JSONL**：每行一条记录，只需 `appendFile`。天然支持增量写入和崩溃恢复。

### 核心设计：串行写入队列

```typescript
class JsonlHistorySink implements HistorySink {
    private writeQueue: Promise<void> = Promise.resolve()

    async append(event: HistoryEvent) {
        // 用 Promise 链保证写入顺序
        this.writeQueue = this.writeQueue.then(async () => {
            await this.ensureDirectory()
            await appendFile(this.filePath, JSON.stringify(event) + '\n')
        })
        return this.writeQueue
    }
}
```

**为什么用 Promise 链？**
→ Node.js 的 `appendFile` 是异步的。如果多个事件同时 append，写入顺序不确定。
Promise 链（`.then()` 串联）保证严格按调用顺序写入。

### 集成到 Session

只在两个点写入事件：

```typescript
async runTurn(input: string) {
    // 1. turn 开始时记录用户输入
    if (this.historySink) {
        await this.historySink.append(createHistoryEvent({
            type: 'turn_start', content: input, role: 'user',
        }))
    }

    const result = await runTurn(input, { ... })

    // 2. turn 结束时记录最终回复
    if (this.historySink) {
        await this.historySink.append(createHistoryEvent({
            type: 'final', content: result.finalText,
            meta: { status, steps, tokenUsage },
        }))
    }
}
```

**为什么只记录 start + final，而不记录每个 action/observation？**
→ 最小集成原则。action/observation 事件需要修改 `react-loop.ts`，这是更深层的改动。
先做 Session 层就够用了，未来可以逐步深入。

---

## 总结：四个功能的思考清单

| 功能 | 核心思考 | 关键技巧 |
|------|---------|---------|
| `get_memory` | 映射表替代硬编码 | `MEMORY_FILES` Record 可扩展 |
| `search_files` | 不引入依赖，自写 glob | Set 排除列表 + 结果上限 |
| Model Profile | 模型能力差异化 | 最长前缀匹配 + `stream: false` |
| JSONL History | JSONL 优于 JSON | Promise 链串行写入 |

每个功能都遵循同一个模式：
1. **先读 memo-code 的实现** → 理解意图
2. **找到 cclin 的简化版** → 不照搬，做适合自己的
3. **最小集成** → 改最少的文件，跑通验证


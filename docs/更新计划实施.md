# 实战学习：如何实现 `update_plan` 工具

> 📅 2026-03-29 | Phase 10 第一个工具实现
> 本文记录从零开始为 cclin Agent 添加一个新工具的完整思考过程。

---

## 背景：为什么做这个

在 PLAN.md 的 Phase 10 中，有一项待办：

```
- get_memory / update_plan 工具
```

`update_plan` 的作用是让 Agent **自己能创建和更新计划文件**。想象一下：你让 Agent 做一个复杂重构任务，Agent 先用 `update_plan` 生成一个清单，每完成一步就更新状态。这样你可以随时查看 `.xxx.plan.md` 文件知道进度。

---

## 第一步：观察现有模式（Explore Before Implement）

> 💡 **思考逻辑**：不要上来就写代码。先搞清楚"现有工具长什么样"，才能写出风格一致的新工具。

我打开了 `read-file.ts` 和 `write-file.ts`，提炼出了工具实现的**标准模板**：

```typescript
// 每个工具文件的结构模式
export const xxxTool: ToolDefinition = {
    name: 'xxx',           // 1. 工具名（LLM 用这个名字来调用）
    description: '...',     // 2. 描述（LLM 读这段来理解用途）
    inputSchema: { ... },   // 3. JSON Schema（定义参数格式）
    isMutating: true/false, // 4. 是否修改外部状态
    execute(input) { ... }, // 5. 执行逻辑
}
```

我注意到几个关键点：

| 观察点 | 具体发现 | 对新工具的影响 |
|--------|----------|----------------|
| 安全验证 | 每个涉及文件的工具都调用 `validatePath()` | `update_plan` 也必须验证路径 |
| 错误处理 | 统一用 `{ output: '...', isError: true }` | 保持一致的返回格式 |
| `isMutating` | 写文件的工具标记为 `true` | `update_plan` 写文件 → `true` |
| 输入提取 | 用 `String(input.xxx ?? '')` 防御性提取 | 同样做防御性提取 |

---

## 第二步：设计工具的"接口"（面向 LLM 设计）

> 💡 **思考逻辑**：工具的 `description` 和 `inputSchema` 不是给人看的——是给 **LLM** 看的。LLM 根据这些信息决定"什么时候调用"和"传什么参数"。

### 问题 1：接收什么参数？

- `plan_id` → 文件名标识符（如 `"refactor-auth"`）
- `title` → 计划标题
- `steps[]` → 步骤数组，每个有 `description` + `status`
- `notes` → 可选备注

### 问题 2：为什么用 `plan_id` 而不是 `path`？

因为工具要**约束**文件名格式：`.{plan_id}.plan.md`。

- `.` 前缀 → 隐藏文件，不干扰项目目录
- `.plan.md` 后缀 → 明确标识用途
- Agent 只需提供一个 ID，不需要操心路径

这是**封装思想**：把复杂性藏在工具内部，给 LLM 一个简洁的接口。

### 问题 3：`ToolInputSchema` 的限制

看 `types.ts` 里的定义，`items` 只能写 `{ type: string }`，无法嵌套描述对象字段。

**解法**：在 `description` 里用自然语言描述结构：

```typescript
steps: {
    type: 'array',
    description: 'Array of step objects. Each has: '
        + 'description (string), '
        + 'status ("pending"|"in_progress"|"done").',
    items: { type: 'object' },
}
```

LLM 完全能理解自然语言描述，JSON Schema 不够精确不是问题。

---

## 第三步：实现工具（逐层构建）

> 💡 **思考逻辑**：从简单到复杂，一层层搭建。

### 3.1 状态映射表

计划步骤有三种状态，对应 Markdown checklist 语法：

```typescript
const STATUS_MAP: Record<PlanStep['status'], string> = {
    pending:     '[ ]',   // 未开始
    in_progress: '[/]',   // 进行中（自定义语法）
    done:        '[x]',   // 已完成
}
```

为什么用 `Record<PlanStep['status'], string>` 而不是普通对象？
→ TypeScript 会**强制你覆盖所有状态**。如果以后新增状态忘记加映射，编译器会报错。

### 3.2 `execute()` 函数的防御性编程

```typescript
async execute(input) {
    // 1️⃣ 安全提取：input 是 Record<string, unknown>
    //    LLM 可能传错类型，用 String() 强制转换
    const planId = String(input.plan_id ?? '').trim()
    const title = String(input.title ?? '').trim()
    const rawSteps = input.steps as PlanStep[] | undefined

    // 2️⃣ 前置校验：参数不合法就立刻返回错误
    if (!planId) return { output: 'Error: plan_id is required.', isError: true }
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
        return { output: 'Error: steps must be a non-empty array.', isError: true }
    }

    // 3️⃣ 安全检查：调用 validatePath 验证路径
    const filename = `.${planId}.plan.md`
    const validation = validatePath(filename)
    if (!validation.ok) return { output: validation.error, isError: true }
    // ...
}
```

每一步都有明确的**失败出口**。这是"防御性编程"的核心模式：早验证、早返回。

### 3.3 Markdown 内容生成

输出格式（示例）：

```markdown
# Refactor Auth Module

## Steps

- [x] Analyze existing auth code
- [/] Extract shared logic into utils
- [ ] Update unit tests
- [ ] Review and merge

## Notes

Focus on password hashing first.
```

生成逻辑：

```typescript
const lines: string[] = [`# ${title}`, '', '## Steps', '']

for (const step of rawSteps) {
    const desc = String(step.description ?? '(no description)')
    const status = STATUS_MAP[step.status] ?? STATUS_MAP.pending
    lines.push(`- ${status} ${desc}`)
}

if (notes) {
    lines.push('', '## Notes', '', notes)
}
```

注意 `STATUS_MAP[step.status] ?? STATUS_MAP.pending`：如果 LLM 传了无效状态，**默认降级为 pending** 而不是报错。这是容错设计——LLM 有时候会传出意外值。

---

## 第四步：注册工具

> 💡 **思考逻辑**：工具文件写好了还不够，必须注册到路由系统里，LLM 才能发现和调用它。

在 `index.ts` 里只需两步：

```diff
 import { listDirectoryTool } from './tools/list-directory.js'
+import { updatePlanTool } from './tools/update-plan.js'

 router.registerNativeTools([
     readFileTool,
     writeFileTool,
     editFileTool,
     bashTool,
     listDirectoryTool,
+    updatePlanTool,
 ])
```

工具注册后，`ToolRouter` 会：
1. 将其加入 `nativeRegistry`
2. `toOpenAITools()` 会把它转为 OpenAI function calling 格式
3. `toMarkdown()` 会把描述注入系统提示词
4. LLM 看到工具描述后，就知道什么时候该调用它

---

## 第五步：验证

```bash
# TypeScript 编译检查（0 错误）
npx tsc --noEmit

# 运行现有测试（全部通过）
npx vitest run
```

所有现有测试继续通过，说明新工具没有破坏任何现有功能。

---

## 附录：关于 Codex CLI 委托尝试

本次实现最初尝试通过 `collaborating-with-codex` 工作流委托给 Codex CLI：

```bash
python codex_bridge.py --cd "d:\...\cclin" --return-all-messages --PROMPT "..."
```

但 Codex 上游 API 返回 **404 Not Found**（`/v1/responses` 端点），两次重试均失败。这是外部服务不可用的问题，不是配置错误。最终决定直接实现。

**教训**：委托给外部工具时，永远要有 fallback 方案。

---

## 总结：实现新工具的思考清单

1. **先观察** → 找到现有工具的代码模式
2. **设计接口** → 从 LLM 视角设计 `description` 和 `inputSchema`
3. **防御编程** → 输入提取用 `String()` / `??`，提前校验提前返回
4. **路径安全** → 涉及文件操作必须调用 `validatePath()`
5. **容错降级** → 无效输入用默认值而非抛错
6. **约束命名** → 用 `plan_id` 封装文件路径生成逻辑
7. **注册工具** → 加入 `index.ts` 的注册数组
8. **验证** → `tsc --noEmit` + `vitest run`

---

## 附录 B：Codex CLI 的实现对比

Codex CLI 最终在第 4 次尝试时成功返回了自己的 `update-plan.ts` 版本。以下是两个版本的设计差异对比：

### Codex 的工作流程

1. 调用 `codebase-retrieval` MCP 工具索引整个项目
2. 用 PowerShell `Get-Content` 读取 5 个源文件
3. 读取我们已有的 `implementing-update-plan.md` 了解设计意图
4. 输出完整的工具代码

### 关键设计差异

| 维度 | 我的版本 | Codex 版本 | 取舍 |
|------|----------|------------|------|
| `plan_id` 校验 | 无格式限制 | 正则 `/^[A-Za-z0-9._-]+$/` | Codex 更安全，防止特殊字符注入 |
| 步骤验证 | 整体检查 `Array.isArray` | 逐个验证每步，带索引错误 | Codex 的错误信息更精确 |
| 进行中状态 | `[/]` checkbox 语法 | `[ ] ... (in progress)` 后缀 | 我的更语义化，Codex 更兼容标准 Markdown |
| 无效状态处理 | 降级为 `pending` | 直接报错拒绝 | 我的容错更强，Codex 更严格 |
| 状态映射 | `STATUS_MAP` Record 常量 | 内联 if 判断 | Record 更易扩展，if 更直观 |

### 学到的关键启示

Codex 版本有两个值得借鉴的做法：

1. **`plan_id` 格式校验**：防止 LLM 传入 `../hack` 之类的恶意 ID
2. **逐步验证 + 索引错误**：`steps[2].description is required` 比 `steps must be valid` 有用得多



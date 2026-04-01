# 为什么需要"防御性编程"与"有意的重复"？

> 这篇笔记解答：为什么工具执行层的输入参数要定义为 `unknown`，为什么每个工具的开头都在做类似的数据校验（防守），以及为什么不把它们抽象成一个公共函数。

---

## 1. 为什么 LLM 的输入是 `unknown`？

在强类型的 TypeScript 世界里，我们习惯了只要定义好类型，一切就安全了：
```typescript
type ReadFileArgs = { path: string; offset?: number };
```

但是！**LLM 输出的是一段纯文本字符串**，你的程序用 `JSON.parse("...")` 把它转成了对象。

请看这个残酷的事实：`JSON.parse()` 的返回值在 TypeScript 里被定义为 `any`（或者更安全的 `unknown`）。这是因为 **TypeScript 无法在编译时知道运行时的那段字符串到底长什么样**。

即使我们在 `ToolInputSchema` 里告诉 LLM："你必须返回一个有 `path` 的对象"，**LLM 仍然可能发神经**，返回给你：
1. 缺少必填项：`{}`
2. 类型错误：`{ "path": 123 }` 或 `{ "path": ["src", "index.ts"] }`
3. 拼写错误：`{ "filepath": "index.ts" }`
4. 甚至是一串破损的 JSON（虽然 `JSON.parse` 阶段就会抛错，但假设解析成功了，格式依然无法保证完美）

所以，工具接口的真实签名是：
```typescript
execute: (input: Record<string, unknown>) => Promise<ToolResult>
```
`unknown` 是在时刻提醒开发者：**永远不要相信从网络（尤其是大模型）发来的数据。**

---

## 2. 什么是防御性处理？

既然拿到的是一个"不值得信任"的对象，在调用 node 原生 `fs` 等 API 前，就必须把脏数据洗净。这就是**防御性编程**。

看 `read_file` 的开头：
```typescript
// input 类型是 Record<string, unknown>

// 1. 防御性获取 path
// ?? '' 防御了 path 缺失 (undefined / null)
// String() 防御了类型不对（比如 LLM 传了 { path: 123 } 或 { path: true }）
const filePath = String(input.path ?? '')

// 2. 拦截错误
if (!filePath) {
    return { output: 'Error: path is required.', isError: true }
}
```

如果是传统的内部调用，你肯定只需写 `const filePath = input.path;`。但对于 LLM，只有经过上述"防弹处理"，才能安全地把 `filePath` 扔给后续的文件系统层。如果不做拦截，底层代码运行时就会报错导致 Agent 崩溃挂起。

---

## 3. 什么是"有意的重复" (Intentional Duplication)

在 `read_file`, `write_file`, `edit_file`, `bash` 等工具的源码中，你都会看到类似这样的开头：

```typescript
// bash 工具
const command = String(input.command ?? '')
if (!command) return { ... }

// write_file 工具
const filePath = String(input.path ?? '')
const content = String(input.content ?? '')
if (!filePath) return { ... }
```

**你可能会想：代码这么重复，为什么不写一个 `validateInput(input, ['path', 'content'])`  的通用校验函数？**

因为在 Phase 3 的现阶段（工具数量很少只有 5 个），保持这种"散落每个函数内"的写法是**有意为之的架构决策**。

### 好处：

1. **零依赖与极简性**：不想引入复杂的校验库（像 `zod` 或 `yup`），自己手写几行防御代码，让整个工具有着极高的可读性——任何新人打开 `read-file.ts`，从上到下扫一眼就明白了所有处理逻辑，不需要跳去查另一个校验函数的实现。
2. **定制化处理极其方便**：
   - 比如 `offset` 需要的是非负整数且提供默认值：`Math.max(0, Number(input.offset) || 0)`
   - 比如 `timeout` 需要默认给 30000 毫秒等。
   如果强行提取出一个公共校验器，校验器必须增加各种参数支持"数字、默认值、非负判断"…… 最终，校验器的逻辑会变得比原始代码还复杂难懂（所谓的**过度抽象**）。

**软件工程原则**："比起稍显笨拙的重复，过早的抽象（Premature Abstraction）带来的维护灾难更可怕。" 
在目前工具只有少数字段的规模下，让每个工具**自己负责自己参数的清洗**，是最强健且易于阅读的做法。

# Batch 6 & 7 — 多模态输入与 Subagent 系统实现笔记

> 记录两大新特性的**设计动机、实现路径、关键代码**，方便日后回顾。

---

## 一、多模态图片输入（Batch 6）

### 1.1 要解决的问题

原系统所有消息（用户输入 → LLM → 历史记录）都是纯字符串。
现代视觉模型（gpt-4o 等）支持在同一条消息里混入图片，
需要在不破坏现有文本流程的前提下，**让用户能附加图片一起发给 LLM**。

---

### 1.2 类型系统改造（`src/types.ts`）

OpenAI Vision API 要求 `content` 是一个 **数组**，每个元素是 `text` 或 `image_url` 块：

```ts
// 新增
export type TextContentPart  = { type: 'text'; text: string }
export type ImageContentPart = {
  type: 'image_url'
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' }
}
export type ContentPart = TextContentPart | ImageContentPart

// 联合类型：纯文本 OR 多模态数组
export type UserContent = string | ContentPart[]
```

`ChatMessage` 的 `user.content` 字段从 `string` 改为 `UserContent`。
这个改动是**整条链路的源头**，后面所有适配都围绕它展开。

---

### 1.3 图片处理模块（`src/tui/image-attach.ts`）

TUI 层需要把文件路径转成 LLM 能接受的格式。该模块承担三件事：

| 职责 | 说明 |
|------|------|
| **校验** | 只允许 png/jpg/jpeg/webp/gif，大小 ≤ 20 MB |
| **编码** | `fs.readFile` → Buffer → `base64`，拼成 `data:<mime>;base64,<data>` |
| **构建** | 返回 `ImageAttachment`（含文件名、MIME、base64 data URL） |

```ts
export async function loadImageAttachment(filePath: string): Promise<ImageAttachment>

// 把文字 + 附件列表 → ContentPart[] 供 LLM 消费
export function buildMultimodalContent(text: string, attachments: ImageAttachment[]): ContentPart[]
```

`buildMultimodalContent` 的结构：先放一个 `text` 块，再依次追加每张图的 `image_url` 块。

---

### 1.4 TUI 交互层（`src/tui/input.tsx` → `app.tsx`）

**数据流**：

```
用户键入 /image ./foo.png
  → input.tsx 拦截 /image 命令
  → 异步调用 loadImageAttachment()
  → 追加到 pendingAttachments 状态
  → 渲染 "📎 [Image #1] foo.png (42 KB)"

用户回车提交
  → onSubmit(text, attachments) 回调
  → app.tsx handleSubmit 调用 buildMultimodalContent()
  → 生成 ContentPart[]
  → 传给 session.runTurn(content)
```

**为什么把附件放在 TUI 层而不是 Session 层？**
Session 只负责管理对话历史和调用 LLM，它不应该知道"文件路径"这种 IO 细节。
把图片加载和编码放在 TUI 的 input.tsx，Session 只感知最终的 `ContentPart[]`，职责更清晰。

---

### 1.5 LLM 客户端适配（`src/llm/client.ts`）

`toOpenAIMessage` 函数之前对 user 消息直接 `return { role: 'user', content: msg.content }`。
现在需要判断 content 类型：

```ts
if (typeof msg.content === 'string') {
  return { role: 'user', content: msg.content }
}
// 多模态：透传给 OpenAI SDK
return {
  role: 'user',
  content: msg.content.map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    return { type: 'image_url', image_url: { url: part.image_url.url, detail: 'auto' } }
  })
}
```

OpenAI SDK 完全接受这个格式，**无需引入任何新依赖**。

---

### 1.6 其他适配点

| 文件 | 改动原因 |
|------|---------|
| `compaction.ts` `normalizeContent` | content 为数组时，提取文字串联，图块用 `[image]` 占位，防止把 base64 全量写入摘要提示 |
| `compaction.ts` `isContextSummaryMessage` | 数组类型 content 不可能是压缩摘要，先检查 `typeof` 再调 `startsWith` |
| `utils/tokenizer.ts` | `messagePayloadForCounting` 处理数组 content，用于精确估算 Token 数 |
| `runtime/react-loop.ts` | `runTurn` 签名改为 `UserContent`，Hook payload 取文本摘要 |
| `runtime/session.ts` | 同上，历史事件序列化时数组类型记为 `[multimodal]` |

---

## 二、设计收获（多模态视角）

### 2.1 类型安全优先

多模态改造最复杂的地方不是图片编码，而是让 **TypeScript 类型系统在整条链路保持一致**：

```
types.ts: UserContent = string | ContentPart[]
    ↓
react-loop.ts: runTurn(input: UserContent)
    ↓
session.ts: runTurn(input: UserContent)
    ↓
client.ts: toOpenAIMessage — 按 typeof 分支处理
    ↓
compaction.ts / tokenizer.ts — 同样按 typeof 分支
```

每一层都要判断 `typeof content`，编译器会精确指出遗漏处。
这印证了一点：**类型改动的传播范围 = 这个类型被消费的所有位置**。

### 2.2 关注点分离

图片的 IO（读文件、base64 编码）放在 TUI 层的 `image-attach.ts`，
Session 和 react-loop 只感知最终的 `ContentPart[]`，不知道文件路径从哪来。

这样 Session 层对"多模态"完全透明：它只是把 content 存入 history 并转发给 LLM。

### 2.3 向下兼容

`UserContent = string | ContentPart[]` 的联合类型设计保证了：

- 所有已有的纯文本输入路径**零改动**（仍然直接传字符串）
- 只有 TUI 层决定是否构建多模态 content
- Subagent 的 `runTurn` 调用也可以继续传字符串，不受影响

---

> **Subagent 系统** 的详细实现见 [`subagent-implementation.md`](./subagent-implementation.md)，
> 包括：方案一/二的完整代码、状态机、循环依赖解法、对比表与学习要点。


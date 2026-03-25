# JSON Schema 是什么？— 以 ToolInputSchema 为例

> 这篇笔记解答一个基础问题：JSON Schema 到底是什么，
> 以及为什么 `ToolInputSchema` 被称为"JSON Schema 子集"。

---

## 什么是 JSON Schema

JSON Schema 是一个**标准规范**（不是代码库，不需要 `npm install`），
用来**描述 JSON 数据应该长什么样**。你可以把它理解为"JSON 的类型系统"。

给一个 JSON 对象：
```json
{ "path": "/src/index.ts", "offset": 0 }
```

对应的 JSON Schema 描述：
```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "文件路径" },
    "offset": { "type": "integer", "default": 0 }
  },
  "required": ["path"]
}
```

含义：这是一个对象，包含 `path`（字符串，必填）和 `offset`（整数，可选，默认 0）。

**你在代码里看不到 "JSON Schema" 这个字眼**，因为它不是一个库，
而是一个格式约定。OpenAI 的 function calling API 规定：
用 JSON Schema 格式来描述工具的参数。

---

## 完整 JSON Schema vs 我们的子集

完整规范支持几十种关键字：

```
完整 JSON Schema 支持的部分关键字：
type, properties, required, items, enum, default,       ← 我们用了这些
allOf, oneOf, anyOf, not, $ref, $defs, if/then/else,    ← 没用这些
pattern, minLength, maxLength, minimum, maximum,         ← 没用这些
additionalProperties, patternProperties, ...             ← 还有更多
```

我们的 `ToolInputSchema` 只保留了 6 个最常用的字段：

```typescript
export type ToolInputSchema = {
    type: 'object'              // JSON Schema 关键字：类型是对象
    properties: Record<string, {
        type: string            // 每个属性的类型（string/number/boolean/array）
        description?: string    // 属性说明
        items?: { type: string } // 如果是数组，元素的类型
        enum?: string[]         // 枚举值限制
        default?: unknown       // 默认值
    }>
    required?: string[]         // 哪些属性是必填的
}
```

---

## 为什么用子集而不是完整 JSON Schema

1. **IDE 有补全**：写工具参数时编辑器会提示可用字段
2. **防手滑**：写了 `allOf` 这种未支持的关键字，TypeScript 会报错
3. **够用**：Agent 工具参数通常是几个简单字段，6 个关键字完全覆盖

如果未来工具参数变复杂（比如嵌套对象），再扩展这个类型即可。

> **对比 memo-code**：它用 `zod` 库定义 schema，再通过 `.toJSONSchema()` 自动转换。
> 更灵活但也更重。我们 Phase 3 只有 5 个工具，手写完全可控。

---

## 实际例子：`read_file` 工具的 Schema

```typescript
inputSchema: {
    type: 'object',
    properties: {
        path:   { type: 'string', description: 'Absolute or relative path' },
        offset: { type: 'number', description: 'Start line (0-based)', default: 0 },
        limit:  { type: 'number', description: 'Max lines to read', default: 200 },
    },
    required: ['path'],
}
```

这段代码**同时是 TypeScript 对象和合法的 JSON Schema**。
传给 OpenAI API 后，LLM 就知道 `read_file` 接受哪些参数、哪些必填。

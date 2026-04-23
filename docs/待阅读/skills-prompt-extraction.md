# Skills 提示词提取重构 — 学习笔记

> 本次重构将硬编码在 `skills.ts` 中的提示词常量提取为独立的 Markdown 文件，并扩充了内容。

---

## 1. 问题起点：提示词藏在代码里

原来的 `skills.ts` 里有一个常量：

```ts
const SKILLS_USAGE_RULES = `### How to use skills
- If the user names a skill or the task clearly matches a skill's description, use that skill.
- To use a skill: open its \`SKILL.md\` with read_file, follow the instructions inside.
- ...`
```

这段文字的本质是「给 LLM 看的行为规范」，也就是**提示词**。但它被写在 TypeScript 文件里，有几个问题：

1. **改提示词 = 动源代码**。非工程师想调整措辞，必须改 `.ts` 文件，重新构建。
2. **难以格式化**。Markdown 里的标题、列表、分节嵌在反引号模板字符串里，编辑器无法做语法高亮和预览。
3. **无法独立复用**。如果其他模块也需要 skills 规则，只能 import 这个常量——逻辑上是 prompt 层的东西却依赖了 runtime 层。
4. **扩充成本高**。要加内容就得在代码里拼接字符串，容易出错。

---

## 2. 解法：提示词文件化

### 核心思路

把提示词内容移到 `src/runtime/skills-usage.md`，代码里只保留**读文件**的逻辑。

```
src/runtime/
├── prompt.md          ← 已有：主系统提示词模板（同类先例）
├── skills-usage.md    ← 新建：skills 使用规则提示词
└── skills.ts          ← 改：从文件读取，不再硬编码
```

项目里的 `prompt.md` 就是这种模式的先例——系统提示词存在 `.md` 文件里，`prompt.ts` 负责读取和渲染模板变量。这次对 skills 规则做了同样的处理。

---

## 3. 代码变化详解

### 3.1 新函数：`loadSkillsUsageRules()`

```ts
async function loadSkillsUsageRules(): Promise<string> {
    const moduleDir = dirname(fileURLToPath(import.meta.url))
    const rulesPath = join(moduleDir, 'skills-usage.md')
    try {
        return await readFile(rulesPath, 'utf-8')
    } catch {
        // 文件缺失时的兜底：内联最小化规则
        return [
            '### How to use skills',
            '- If the user names a skill or the task matches a skill description, use that skill.',
            '- To use a skill: open its `SKILL.md` with read_file and follow the instructions.',
            '- Resolve relative paths inside SKILL.md relative to the skill directory.',
        ].join('\n')
    }
}
```

**关键点：`import.meta.url` vs `process.cwd()`**

| 方式 | 含义 | 适合场景 |
|---|---|---|
| `process.cwd()` | 当前工作目录（用户从哪里启动的 Node） | 读**项目文件**（AGENTS.md 等） |
| `import.meta.url` | **当前模块文件**所在位置 | 读**与代码打包在一起的资源** |

skills-usage.md 和 skills.ts 是同目录的打包资源，所以必须用 `import.meta.url`，否则换个工作目录启动就找不到文件了。

`fileURLToPath` 是因为 `import.meta.url` 是 `file://` 协议的 URL 字符串（如 `file:///D:/project/skills.js`），需要转成普通路径才能用 `fs.readFile`。

**兜底设计**：`catch` 里保留了一份极简规则。这样即使 `.md` 文件在构建时被意外遗漏，Agent 也不会完全没有 skills 引导，只是规则减少到最小集。

---

### 3.2 签名变更：`renderSkillsSection(skills, usageRules)`

原来：
```ts
export function renderSkillsSection(skills: SkillMetadata[]): string | null
```

现在：
```ts
export function renderSkillsSection(
    skills: SkillMetadata[],
    usageRules: string,          // ← 新增
): string | null
```

**为什么把 `usageRules` 当参数传入，而不是在函数内部读文件？**

因为 `renderSkillsSection` 是一个**纯函数**（相同输入总是相同输出）。如果内部做 IO（读文件），它就变成了有副作用的异步函数，测试时必须 mock 文件系统，复杂度增加。

把 IO 提到外面（`loadSkillsUsageRules`）、渲染保持纯函数，符合「**副作用在边界，纯函数在内部**」的原则。这也是为什么 `renderSkillsSection` 保持同步，而 IO 集中在 `buildSkillsSection` 和 `loadSkillsUsageRules` 里。

---

### 3.3 新封装：`buildSkillsSection(skills)`

```ts
export async function buildSkillsSection(
    skills: SkillMetadata[],
): Promise<string | null> {
    if (skills.length === 0) return null
    const usageRules = await loadSkillsUsageRules()
    return renderSkillsSection(skills, usageRules)
}
```

这是一个**外观函数（Facade）**，把两步操作合并为一步，方便调用方（`index.ts`）使用：

```ts
// index.ts（before）
const skillsText = renderSkillsSection(skills) ?? undefined

// index.ts（after）
const skillsText = (await buildSkillsSection(skills)) ?? undefined
```

调用方不需要知道「还有个文件要读」——这个细节被封装起来了。

---

## 4. 测试怎么变

原来的测试直接调用 `renderSkillsSection(skills)`，现在需要传 `usageRules`。

解决方式：测试文件里定义一个 **mock 规则字符串**，不依赖真实文件：

```ts
const MOCK_RULES = '### How to use skills\n- Use the skill when it matches.'

describe('renderSkillsSection', () => {
    it('should return null for empty skills array', () => {
        expect(renderSkillsSection([], MOCK_RULES)).toBeNull()
    })
    // ...
})
```

而 `buildSkillsSection` 的测试则**真实读文件**（或触发 fallback），验证端到端集成：

```ts
describe('buildSkillsSection', () => {
    it('should return a non-null string for non-empty skills', async () => {
        const skills = [{ name: 'git-push', description: 'Push', path: '/a' }]
        const result = await buildSkillsSection(skills)
        expect(result).toContain('### How to use skills') // ← 文件或 fallback 都包含此标题
    })
})
```

**层次分明**：纯渲染逻辑用 mock 测，IO 集成用真实文件测。

---

## 5. 提示词内容扩充了什么

原来只有 6 条 bullet，现在有 5 个小节：

| 原版 | 新版对应节 |
|---|---|
| 名字匹配就用 | **When to activate** — 触发条件 + 反向排除 |
| 用 read_file 打开 SKILL.md | **How to invoke** — 4 步流程，含错误处理 |
| 相对路径解析 | **Path resolution** — 独立节，更清晰 |
| 只加载需要的 | **Context discipline** — 防 context 膨胀 |
| 失败则说明 | **Fallback and safety** — 冲突/破坏性操作兜底 |

扩充基于两类参考：
1. Claude Code 官方文档中对 skills 的描述（progressive disclosure 原则）
2. AI Agent prompt 工程最佳实践（技能触发条件、边界定义、确定性优先）

---

## 6. 设计原则总结

| 原则 | 本次体现 |
|---|---|
| **关注点分离** | 提示词内容 vs 加载逻辑分离到不同文件 |
| **纯函数优先** | `renderSkillsSection` 保持同步纯函数，副作用在外层 |
| **外观封装** | `buildSkillsSection` 屏蔽内部细节，简化调用方 |
| **兜底设计** | catch 里保留最小化 fallback，避免单点故障 |
| **可维护性** | 提示词改动不再需要触碰 TypeScript 代码 |

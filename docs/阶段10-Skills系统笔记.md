# 实战学习：Skills 系统实现

> 📅 2026-04-03 | Phase 10 Skills 系统
> 本文记录为 cclin Agent 添加技能发现和 prompt 注入系统的完整过程。

---

## 背景：什么是 Skills？

Skills 是存放在 `SKILL.md` 文件中的本地指令集。Agent 在启动时扫描特定目录，发现可用的 skill，然后将它们的元数据（名称、描述、路径）注入到系统提示词中。当用户的任务匹配某个 skill 时，Agent 会打开对应的 `SKILL.md` 获取详细指令来执行。

**核心流程**：
```
启动 → 扫描目录 → 发现 SKILL.md → 解析 frontmatter → 注入 prompt → LLM 感知
```

---

## 第一步：分析 memo-code 的实现

memo-code 的 `skills.ts`（322 行）做了以下事情：

| 功能 | 实现方式 |
|------|----------|
| 文件扫描 | `fast-glob` 库，支持 6 层深度 |
| frontmatter 解析 | 自写 YAML 解析器，支持多行值 |
| 搜索根 | 项目隐藏目录 + `~/.memo/skills` |
| prompt 注入 | `renderSkillsSection()` 生成带使用规则的文本 |

**我的简化决策**：

| 维度 | memo-code | cclin |
|------|-----------|-------|
| 文件扫描 | `fast-glob` | `fs.readdir` 递归 — 不新增依赖 |
| frontmatter | 支持多行值 | 只支持单行 — LLM 场景够用 |
| 搜索根 | 项目所有隐藏目录 + `~/.memo` | 只扫两个：`.agents/skills/` + `~/.cclin/skills/` |
| 深度 | 6 层 | 4 层 |

---

## 第二步：实现关键模块

### 2.1 Frontmatter 解析

SKILL.md 文件格式：
```markdown
---
name: git-push
description: Push all changes to remote repository
---

# Git Push Skill
详细指令...
```

解析分两步：
1. `extractFrontmatter()` — 提取 `---` 之间的文本
2. `parseFrontmatterValue()` — 用正则提取 `key: value`，支持引号剥离和空白归一化

### 2.2 递归目录扫描（不引入依赖）

memo-code 用 `fast-glob`，我选择自己写递归扫描：

```typescript
async function scanDirectory(
    dir: string,
    depth: number,
    results: SkillMetadata[],
    maxSkills: number,
    seenPaths: Set<string>,
): Promise<void> {
    if (depth > MAX_SCAN_DEPTH || results.length >= maxSkills) return

    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
        if (entry.isFile() && entry.name === SKILL_FILENAME) {
            // 读取并解析
        } else if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
            await scanDirectory(fullPath, depth + 1, ...)
        }
    }
}
```

**关键设计**：
- `SKIP_DIRS` 用 `Set` 存储需要跳过的目录（`node_modules`, `.git` 等）
- `seenPaths` 防止同一文件被重复扫描（符号链接场景）
- `maxSkills` 上限防止扫描过多文件

### 2.3 Prompt 注入

`renderSkillsSection()` 将 skills 列表渲染为 Markdown 文本，包含：
1. 可用技能列表（名称 + 描述 + 路径）
2. 使用规则（何时触发、如何加载、上下文管理）

注入位置在 `prompt.ts` 的组装链中：
```
模板渲染 → SOUL.md → Skills section → AGENTS.md
```

Skills 放在 AGENTS.md 之前，因为 AGENTS.md 是项目级指令，优先级最高。

---

## 第三步：集成与验证

### 改动范围

| 文件 | 改动 |
|------|------|
| `src/runtime/skills.ts` | **新建** — 230 行，核心模块 |
| `src/runtime/skills.test.ts` | **新建** — 8 个测试用例 |
| `src/runtime/prompt.ts` | 增加 `skillsText` 选项，+5 行 |
| `src/index.ts` | 导入 + 调用 loadSkills，+8 行 |

### 验证结果

- ✅ TypeScript 编译：0 错误
- ✅ 全部测试通过：132 / 132

---

## 总结：设计要点

1. **不引入依赖** — `fs.readdir` 递归扫描完全够用，保持零新依赖
2. **两级搜索根** — 项目级（`.agents/skills/`）和用户级（`~/.cclin/skills/`），清晰明确
3. **简化 frontmatter** — 只支持单行值，满足 `name` + `description` 的需求
4. **防御性设计** — 深度限制、数量上限、跳过目录、去重
5. **最小集成** — 只改 `prompt.ts`（加选项）和 `index.ts`（调用），不动核心循环

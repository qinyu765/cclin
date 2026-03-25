---
description: cclin Agent 项目开发协作流程
---

# 开发协作 Workflow

## 角色分工
- **AI（你）**：编写代码、编写测试、运行验证
- **User（我）**：Review 代码、提出修改意见、手写练习

## 协作流程

### 正常开发流程
1. 确认当前要开发的 Phase 和具体功能点
2. AI 编写代码（每次最多 2 个文件）
3. User Review 代码
4. 运行验证（构建/测试/手动）
5. 通过后勾选 PLAN.md 中对应项
6. 使用 git-push skill 提交并推送变更，然后进入下一项

### 手写练习流程
当 User 想手写某段代码时：
1. User 标注想手写的代码段
2. AI 删除该代码段，保留函数签名和类型定义
3. AI 给出设计思路提示（不给完整答案）
4. User 编写代码
5. AI 审查 User 的实现，给出改进建议
6. 通过后继续正常流程

### Phase 切换
1. 当前 Phase 所有功能点完成
2. 运行完整验证
3. 更新 PLAN.md 标记完成
4. 使用 git-push skill 提交并推送变更
5. 开始下一个 Phase

## 代码规范
- **注释语言**：所有代码注释（包括行注释、块注释、JSDoc）统一使用**中文**
- **Git 提交信息**：保持**中文**

## 关键文件
- `PLAN.md` — 总体计划和进度追踪
- `AGENTS.md` — 项目级 Agent 指令
- `src/index.ts` — 入口文件
- `src/types.ts` — 共享类型定义
- `src/llm/` — LLM 客户端封装
- `.env` — API Key 配置（不提交 git）

## 常用命令
// turbo-all
```
# 安装依赖
pnpm install

# 开发运行
pnpm dev

# TypeScript 类型检查
pnpm typecheck
```
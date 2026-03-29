# 单元测试完全指南

> 从"要不要写测试"到"怎么写好测试"，一份面向实际项目的单元测试入门与实践指南。

---

## 一、项目需要写测试吗？

**简短回答：需要。**

但更准确的说法是——**取决于项目的生命周期和复杂度**：

| 场景 | 是否需要测试 | 原因 |
|------|-------------|------|
| 一次性脚本 / Demo | 可以不写 | 用完即弃，维护成本为零 |
| 个人学习项目 | 建议写 | 培养测试习惯，且能帮你验证理解是否正确 |
| 会持续迭代的项目 | **必须写** | 没有测试 = 每次改动都是在冒险 |
| 多人协作项目 | **必须写** | 测试是团队沟通的契约，保证别人改了代码不会破坏你的功能 |
| 开源项目 / 生产系统 | **必须写** | 没有测试的开源项目很难获得信任和贡献者 |

### 为什么需要测试？

1. **防回归（Regression）**：你修了 Bug A，怎么确保没有引入 Bug B？测试能自动回答这个问题。
2. **安全重构**：想优化代码结构？有测试在，你就敢大胆改，因为跑一遍测试就知道有没有改坏。
3. **活文档**：好的测试就是最好的文档——它精确描述了函数在各种输入下的预期行为。
4. **设计压力**：写不出测试的代码，往往说明这段代码耦合太紧、职责不清。测试会"逼"你写出更好的代码。

---

## 二、TDD：先写测试还是先写代码？

### 什么是 TDD（Test-Driven Development）

TDD 是一种**开发方法论**，核心流程叫做 **Red-Green-Refactor**：

```
┌──────────────────────────────────────────┐
│  1. RED    → 先写一个失败的测试           │
│  2. GREEN  → 写最少的代码让测试通过       │
│  3. REFACTOR → 重构代码，保持测试绿色     │
│  └── 循环往复                            │
└──────────────────────────────────────────┘
```

### TDD 的实际例子

假设你要实现一个 `add(a, b)` 函数：

**第一步（RED）**—— 先写测试：

```typescript
// add.test.ts
import { add } from './add';

test('两个正数相加', () => {
  expect(add(1, 2)).toBe(3);
});
```

此时 `add` 函数还不存在，测试必然失败（红色）。

**第二步（GREEN）**—— 写最少的实现：

```typescript
// add.ts
export function add(a: number, b: number): number {
  return a + b;
}
```

测试通过了（绿色）。

**第三步（REFACTOR）**—— 考虑边界情况，补充测试：

```typescript
test('负数相加', () => {
  expect(add(-1, -2)).toBe(-3);
});

test('零的处理', () => {
  expect(add(0, 5)).toBe(5);
});
```

### 必须严格 TDD 吗？

**不是。** TDD 是一种工具，不是教条。实际开发中有三种常见做法：

| 方式 | 适用场景 | 说明 |
|------|---------|------|
| **严格 TDD**（先写测试） | 逻辑密集型代码（算法、数据处理、业务规则） | 测试驱动你思考边界情况 |
| **代码优先，随后补测试** | UI 代码、探索性开发、原型验证 | 代码稳定后再补测试固化行为 |
| **同步写** | 大部分日常开发 | 写一个函数，立刻写对应测试 |

> **关键原则**：不管什么顺序，代码交付时必须有测试覆盖关键路径。

---

## 三、测试的分类与金字塔

```
          ╱╲
         ╱  ╲        E2E 测试（端到端）
        ╱    ╲       - 模拟真实用户操作
       ╱──────╲      - 数量最少，运行最慢
      ╱        ╲
     ╱  集成测试  ╲    Integration Tests
    ╱            ╲   - 测试模块间协作
   ╱──────────────╲  - 数量适中
  ╱                ╲
 ╱    单元测试       ╲  Unit Tests
╱                    ╲ - 测试单个函数/类
╲────────────────────╱ - 数量最多，运行最快
```

### 单元测试（Unit Test）

- **测什么**：一个函数、一个方法、一个类的单个行为
- **特点**：快速（毫秒级）、隔离（不依赖数据库/网络/文件系统）
- **例子**：测试 `formatDate()` 是否正确格式化日期

```typescript
test('格式化日期为 YYYY-MM-DD', () => {
  const date = new Date('2026-03-28');
  expect(formatDate(date)).toBe('2026-03-28');
});
```

### 集成测试（Integration Test）

- **测什么**：多个模块组合在一起是否正常工作
- **特点**：较慢，可能需要真实依赖（如数据库）
- **例子**：测试 API 接口从请求到数据库写入的完整流程

### 端到端测试（E2E Test）

- **测什么**：整个应用从用户视角是否正确
- **特点**：最慢，模拟真实浏览器或客户端
- **例子**：用 Playwright 模拟用户登录、下单的完整流程

---

## 四、单元测试实战技巧

### 1. 测试的 3A 模式

每个测试都应遵循 **Arrange-Act-Assert** 结构：

```typescript
test('用户余额不足时抛出错误', () => {
  // Arrange（准备）—— 设置测试前提条件
  const user = { balance: 50 };
  const item = { price: 100 };

  // Act（执行）—— 调用被测函数
  const result = () => purchase(user, item);

  // Assert（断言）—— 验证结果
  expect(result).toThrow('余额不足');
});
```

### 2. 什么值得测？

| ✅ 值得测 | ❌ 不值得测 |
|-----------|------------|
| 业务逻辑（计算、校验、转换） | 简单的 getter/setter |
| 边界情况（空值、极大值、空数组） | 框架自身的功能 |
| 错误处理路径 | 纯 UI 样式（颜色、字号） |
| 复杂的条件分支 | 第三方库的内部实现 |
| 公开 API 的契约 | 私有辅助函数（通过公开 API 间接测试） |

### 3. Mock 和 Stub：隔离外部依赖

当函数依赖外部服务（如 HTTP 请求、数据库），用 Mock 替换它们：

```typescript
import { jest } from '@jest/globals';
import { fetchUserProfile } from './api';
import { getUserDisplayName } from './user';

// Mock 整个 api 模块
jest.mock('./api');

test('显示用户名', async () => {
  // 模拟 API 返回值
  (fetchUserProfile as jest.Mock).mockResolvedValue({
    name: 'Alice',
    avatar: 'alice.png',
  });

  const name = await getUserDisplayName('user-123');
  expect(name).toBe('Alice');
});
```

**何时用 Mock**：
- 外部 API 调用
- 数据库操作
- 文件系统读写
- 定时器 / 随机数

**何时不用 Mock**：
- 纯函数（输入输出确定，不需要 Mock）
- 简单的数据结构操作

### 4. 测试命名规范

好的测试名称就是一份规格说明：

```typescript
// ❌ 模糊的命名
test('test add', () => { ... });

// ✅ 描述行为的命名
test('两个正数相加返回正确的和', () => { ... });
test('传入非数字参数时抛出 TypeError', () => { ... });
test('当购物车为空时返回零总价', () => { ... });
```

推荐模式：**"当 [条件] 时，应该 [预期行为]"**

---

## 五、在 cclin 项目中的实际应用

以本项目为例，以下模块特别适合写单元测试：

| 模块 | 测试重点 |
|------|---------|
| `ToolRegistry` | 注册/查找/序列化工具定义是否正确 |
| `ApprovalManager` | 各种审批策略（always/once/auto）的行为 |
| `PromptEngine` | 模板渲染、变量替换是否正确 |
| `HistorySummarizer` | 历史压缩是否保留关键信息 |
| `TokenCounter` | Token 计数是否准确 |
| `HookEngine` | 事件注册/触发/错误隔离是否正常 |

### 示例：为 ApprovalManager 写测试

```typescript
import { ApprovalManager } from './approval';

describe('ApprovalManager', () => {
  let manager: ApprovalManager;

  beforeEach(() => {
    manager = new ApprovalManager();
  });

  test('默认策略为 always（每次都要审批）', () => {
    expect(manager.needsApproval('any_tool')).toBe(true);
  });

  test('auto 策略跳过审批', () => {
    manager.setPolicy('auto');
    expect(manager.needsApproval('any_tool')).toBe(false);
  });

  test('once 策略：首次需要审批，同一工具再次调用不需要', () => {
    manager.setPolicy('once');
    // 首次 —— 需要审批
    expect(manager.needsApproval('read_file')).toBe(true);
    // 标记为已审批
    manager.markApproved('read_file');
    // 再次 —— 不需要
    expect(manager.needsApproval('read_file')).toBe(false);
  });
});
```

---

## 六、常用测试工具

| 工具 | 语言/生态 | 说明 |
|------|----------|------|
| **Vitest** | TypeScript / Vite 生态 | 速度快，兼容 Jest API，推荐用于 TS 项目 |
| **Jest** | JavaScript / TypeScript | 最流行的 JS 测试框架，开箱即用 |
| **Mocha + Chai** | JavaScript | 灵活搭配，老牌组合 |
| **Playwright** | 浏览器 E2E | 跨浏览器端到端测试 |
| **pytest** | Python | Python 生态最流行的测试框架 |
| **Go test** | Go | Go 语言内置测试工具 |

---

## 七、总结

1. **项目需要测试吗？** —— 只要不是一次性脚本，就需要。
2. **必须 TDD 吗？** —— 不必，但关键逻辑推荐先写测试。
3. **从哪开始？** —— 从纯函数和核心业务逻辑开始，这些最容易测、价值最高。
4. **测试不是负担** —— 短期多花 10 分钟写测试，长期能省数小时的调试时间。
5. **好的测试 = 好的设计** —— 如果你发现某段代码很难写测试，说明这段代码设计有问题。

> 💡 **最佳实践**：把"写测试"当成和"写代码"一样自然的习惯，而不是一个额外的任务。

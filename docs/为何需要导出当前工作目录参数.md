# 参数导出与测试环境的依赖注入

> 本文解释了为什么在编写 Node.js CLI 工具时，需要将 `cwd`（当前工作目录）作为参数导出，而不是在函数内部硬编码 `process.cwd()`。

这段话的核心是在讲编程里一个非常重要的思想：**控制反转（依赖注入）。**

我们先看看如果**不导出**这个参数，代码会写成什么样：

```typescript
// ❌ 硬编码版本
export async function loadSystemPrompt(): Promise<string> {
    const cwd = process.cwd() // 永远写死从 Node.js 的运行目录拿值
    const agents = await readProjectAgentsMd(cwd)
    // ...
}
```

这在正常用户使用时没问题：用户在 `D:/my-project` 敲下运行命令，`process.cwd()` 就是那个目录，程序就能正确读到那个目录下的 `AGENTS.md`。

**但这会给“自动化测试环节”带来巨大的灾难。**

假设你正在写一个自动化测试：你想测试“如果项目里包含一个恶意的 AGENTS.md，系统会不会正常把它加载进来”。
测试代码通常是怎么写的？
1. 测试脚本会在内存里，或者系统的临时目录（比如 `/tmp/test-fake-folder/`）动态造一个假的 `AGENTS.md` 文件。
2. 然后测试脚本去调用你的 `loadSystemPrompt()`，看看返回值对不对。

**灾难来了**：因为测试脚本（比如 Jest、Vitest）通常是在你 cclin 自身的源码根目录启动的，所以此时的 `process.cwd()` 铁定是 `d:\For coding\...\cclin` 本身！
它根本不管你在临时目录造了什么假文件，它永远只会傻傻地去读 cclin 源码根目录里真实的那个 `AGENTS.md`。你的测试永远测不准，你也无法模拟各种极端的文件情况。

---

**现在的解决方案：留一个后门（参数化）**

```typescript
// ✅ 现状版本：支持传参覆盖
export async function loadSystemPrompt(options: LoadSystemPromptOptions = {}): Promise<string> {
    const cwd = options.cwd ?? process.cwd() // 如果不传，默认用 process.cwd()。如果传了，听你的！
    // ...
}
```

有了这个参数之后：

1. **普通的正式入口（`index.ts`）**：调用时直接不传，或者传 `process.cwd()`。原汁原味，行为不变。
2. **测试脚本（`xxx.test.ts`）**：调用时明确告诉函数 `await loadSystemPrompt({ cwd: '/tmp/test-fake-folder/' })`。函数就会乖乖地去读带有恶意内容的假 `AGENTS.md` 进行测试。

**总结**：之所以要导出 `cwd` 参数，就是为了让函数“不要自己做决定去哪里找文件”，而是“把决定权交给外面调用它的人”，这让你未来给它写单元测试时会非常轻松。这就叫**提升代码的可测试性（Testability）**。

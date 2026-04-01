# Phase 9 学习笔记：工具路由 & MCP 集成

> 本文档详细记录 Phase 9 的每一步设计决策和思考过程，帮助理解「从零实现 MCP 集成」的全流程。

---

## 0. 问题是什么？

Phase 1-8 完成后，cclin Agent 只能使用**内置工具**（5 个：read_file, write_file, edit_file, bash, list_directory）。如果想接入外部工具（如搜索引擎、数据库查询、代码分析等），就必须手写新的 ToolDefinition 并重新编译。

**Phase 9 的目标**：让 Agent 能通过 **配置文件** 接入任意 MCP (Model Context Protocol) Server 提供的工具，无需修改代码。

---

## 1. 研究阶段：先看参考实现

### 思考过程

> "不要从零发明轮子，先看成熟的实现怎么做。"

参考了 `memo-code` 项目的 MCP 架构，发现了三层结构：

```
memo-code 架构：
  NativeToolRegistry  ← 内置工具
  McpToolRegistry     ← MCP 工具（含连接池 + 缓存）
  ToolRouter          ← 统一路由（合并两者，提供统一接口）
```

### 关键发现

1. **Tool 有统一接口**：不管是内置还是 MCP，都长一样（name, description, inputSchema, execute）
2. **MCP 工具名加前缀**：`serverName_originalToolName`，避免不同 Server 的工具名冲突
3. **优先级**：内置工具优先，MCP 工具 fallback
4. **连接池**：同一 Server 不重复连接

### 简化决策

memo-code 支持 stdio + HTTP + OAuth + 缓存。对于学习项目，我做了**有意简化**：
- **仅 stdio**：最常见的 MCP Server 都是通过 `npm`/`npx` 启动的 stdio 进程
- **不做缓存**：每次启动重新发现工具，避免缓存失效的复杂性
- **不做 OAuth**：stdio 不需要认证

> 关键原则：**先跑通最小可用路径，再考虑扩展。**

---

## 2. 类型设计：先定义"契约"

### 思考过程

> "TypeScript 项目先写类型，类型即架构文档。"

Phase 9 需要哪些新类型？

| 类型 | 用途 | 设计考量 |
|------|------|----------|
| `MCPServerConfig` | MCP Server 的启动配置 | 仅 command/args/env，不支持 HTTP |
| `McpToolDefinition` | MCP 工具定义 | 继承 ToolDefinition，增加 source/serverName/originalName |
| `ToolQueryable` | 工具查询接口 | 让 ToolOrchestrator 不依赖具体类 |
| `MCPConfigFile` | 配置文件格式 | `{ mcpServers: { ... } }` |

### ToolQueryable 的设计意图

原来 `ToolOrchestrator` 的构造参数是具体类 `ToolRegistry`：

```typescript
// 改造前
constructor(private readonly registry: ToolRegistry, ...)

// 改造后  
constructor(private readonly registry: ToolQueryable, ...)
```

为什么？因为 `ToolOrchestrator` 其实只用了 `registry.get(name)` 这一个方法。用接口替代具体类，让 `ToolRouter`（也有 `get()` 方法）可以直接传入。

> 这就是**依赖倒置原则（DIP）**：高层模块不应依赖低层模块，都应依赖抽象。

---

## 3. MCP 客户端：连接管理

### 思考过程

> "MCP 连接涉及子进程生命周期，需要集中管理。"

#### 文件：`src/tools/mcp-client.ts`

核心是 `McpClientPool` 类，职责：

1. **连接** — 通过 stdio 启动 MCP Server 子进程
2. **发现** — 调用 `client.listTools()` 获取工具列表
3. **执行** — 调用 `client.callTool()` 代理执行
4. **清理** — 关闭所有连接

```typescript
// 连接流程（简化版）
const client = new Client(
    { name: 'cclin-agent', version: '0.1.0' },
    { capabilities: {} },
)
const transport = new StdioClientTransport({
    command: config.command,  // 如 'node'
    args: config.args,        // 如 ['server.js']
    stderr: 'ignore',         // 不让 Server 的 stderr 污染 Agent 终端
})
await client.connect(transport)
```

### 为什么用连接池？

如果不用连接池，每次调用工具都要重新启动 Server 进程 → 连接 → 发现 → 执行 → 关闭。连接池做了**连接复用**：

```typescript
async connect(name, config) {
    const existing = this.connections.get(name)
    if (existing) return existing  // 复用！
    // ... 仅首次才启动
}
```

### mergeProcessEnv 的作用

MCP Server 可能需要特定环境变量（如 API Key）。`mergeProcessEnv()` 将用户配置的 env 与 `process.env` 合并，确保 Server 进程继承父进程的环境。

---

## 4. MCP 工具注册表：适配层

### 思考过程

> "MCP 发现的工具和 cclin 的 ToolDefinition 不是同一个格式，需要适配。"

#### 文件：`src/tools/mcp-registry.ts`

关键设计决策：

### 4.1 工具名前缀

```typescript
const qualifiedName = `${serverName}_${rawTool.name}`
// 例如：github_search → "github_search"
// 如果两个 Server 都有 "search" → "github_search" vs "google_search"
```

### 4.2 保守的 isMutating 策略

```typescript
isMutating: true  // MCP 工具默认都需要审批！
```

为什么？因为我们**不知道**外部工具会做什么。宁可多问一次审批，也不要让未知工具悄悄执行危险操作。

### 4.3 execute 闭包

每个 MCP 工具的 `execute` 是一个闭包，捕获了 `serverName` 和 `originalName`：

```typescript
execute: async (input) => {
    const result = await this.pool.callTool(
        serverName,      // 知道调哪个 Server
        rawTool.name,    // 用原始名称（不是加了前缀的）
        input,
    )
    return { output: result, isError: result.startsWith('Error:') }
}
```

---

## 5. 统一路由器：组合模式

### 思考过程

> "现在有两个工具源（内置 + MCP），需要一个统一入口。用组合而非继承。"

#### 文件：`src/tools/router.ts`

`ToolRouter` 内部持有两个注册表，对外提供统一接口：

```typescript
class ToolRouter {
    private nativeRegistry = new ToolRegistry()      // 内置
    private mcpRegistry = new McpToolRegistry()       // MCP
    
    get(name) {
        return this.nativeRegistry.get(name)          // 优先内置
            ?? this.mcpRegistry.get(name)             // fallback MCP  
    }
    
    getAllTools() {
        return [
            ...this.nativeRegistry.getAll(),
            ...this.mcpRegistry.getAll(),
        ]
    }
}
```

### 为什么不继承 ToolRegistry？

继承会让 `ToolRouter` 和 `ToolRegistry` 紧耦合。使用**组合模式**：
- `ToolRouter` 聚合了两个注册表
- 每个注册表独立管理各自的工具
- `ToolRouter` 负责合并和路由

### toMarkdown() 的分组

为提示词生成 Markdown 时，按 Native/MCP 分组，MCP 再按 Server 分组：

```markdown
## Built-in Tools
### read_file
### bash

## External MCP Tools
**Server: github**
### github_search
### github_create_issue
```

---

## 6. 配置加载：约定优于配置

### 思考过程

> "配置文件放哪里？搜索优先级怎么定？"

#### 文件：`src/tools/mcp-config.ts`

搜索路径（优先级从高到低）：
1. `./mcp_config.json` — 项目级配置
2. `~/.cclin/mcp_config.json` — 用户级配置

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_xxx" }
    }
  }
}
```

### 为什么没有配置就返回空对象？

```typescript
// 未找到配置 → 返回 {} → 不是错误！
return {}
```

因为很多用户可能不需要 MCP。如果没有配置文件就报错，会破坏**向后兼容性**。

---

## 7. 集成改造：最小侵入

### 思考过程

> "改动越少越好，减少引入 bug 的风险。"

#### 文件：`src/index.ts` — 3 处改动

```diff
- import { ToolRegistry } from './tools/registry.js'
+ import { ToolRouter } from './tools/router.js'
+ import { loadMcpConfig } from './tools/mcp-config.js'

- const registry = new ToolRegistry()
- registry.registerMany([...])
+ const router = new ToolRouter()
+ router.registerNativeTools([...])
+ const mcpConfig = await loadMcpConfig()
+ if (Object.keys(mcpConfig).length > 0) {
+     await router.loadMcpServers(mcpConfig)
+ }

- const orchestrator = new ToolOrchestrator(registry, approvalManager)
+ const orchestrator = new ToolOrchestrator(router, approvalManager)
```

#### 文件：`src/tools/orchestrator.ts` — 1 处改动

```diff
- private readonly registry: ToolRegistry
+ private readonly registry: ToolQueryable
```

为什么 `ToolOrchestrator` 只改了一个类型？因为它原本就只用了 `registry.get()` 方法。`ToolQueryable` 接口刚好契合这个最小依赖。

---

## 8. 层次关系总结

```
index.ts（入口）
    ├── ToolRouter（统一路由）
    │     ├── ToolRegistry（内置工具：read_file, bash...）
    │     └── McpToolRegistry（MCP 工具适配）
    │           └── McpClientPool（连接管理）
    │                 └── @modelcontextprotocol/sdk（协议层）
    ├── ToolOrchestrator（执行编排）
    │     └── ToolQueryable ← ToolRouter 实现
    └── Session → ReAct Loop → callLLM
```

### 数据流

```
启动时：
  loadMcpConfig() → mcpServers 配置
  ToolRouter.loadMcpServers()
    → McpClientPool.connect() → 启动 stdio 子进程
    → McpClientPool.discoverTools() → 获取工具列表
    → McpToolRegistry 适配为 ToolDefinition

运行时（工具调用）：
  LLM 输出 tool_call("github_search", {...})
    → ToolOrchestrator.executeAction()
      → ToolRouter.get("github_search") → 找到 McpToolDefinition
      → tool.execute(input)
        → McpClientPool.callTool("github", "search", {...})
          → MCP 协议 → Server 执行 → 返回结果
```

---

## 9. 设计模式小结

| 模式 | 在哪里用了 | 为什么 |
|------|-----------|--------|
| **组合模式** | ToolRouter 组合两个注册表 | 避免复杂继承，各注册表独立 |
| **适配器模式** | McpToolRegistry 适配 MCP → ToolDefinition | 统一接口 |
| **连接池** | McpClientPool 缓存连接 | 避免重复启动进程 |
| **依赖倒置** | ToolOrchestrator 依赖 ToolQueryable 接口 | 解耦具体实现 |
| **约定优于配置** | mcp_config.json 搜索路径 | 零配置即可工作 |
| **闭包** | MCP 工具的 execute 捕获 serverName | 延迟绑定，优雅地传递上下文 |


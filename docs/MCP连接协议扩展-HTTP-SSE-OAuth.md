# MCP 连接协议扩展：HTTP/SSE + OAuth 凭据

> 将 McpClientPool 从仅支持 stdio 扩展为同时支持 StreamableHTTP、SSE（含自动 fallback）和 OAuth 凭据注入（Bearer Token / Client Credentials）。

---

## 原始回答

### 问题是什么？

Phase 9 的 MCP 集成最初做了有意简化——仅支持 stdio 传输。这意味着只能连接通过 `npx` 或 `node` 启动的**本地子进程**MCP Server。

但现实中有大量 MCP Server 是以 **HTTP 服务** 形式部署的（如云端的 API 网关、远程协作工具服务），这些服务需要：

1. **HTTP/SSE 传输协议**——通过 URL 连接远程 Server
2. **认证机制**——带上 API Key 或 OAuth 凭据

### 改了哪些文件？

| 文件 | 改动 |
|------|------|
| `src/types.ts` | `MCPServerConfig` 从单一类型变为联合类型 |
| `src/tools/mcp-client.ts` | 新增 transport 工厂 + auth headers 构建 |
| `src/tools/mcp-config.ts` | 更新配置格式注释 |

### 类型设计：联合类型区分 stdio 和远程

```typescript
// 本地子进程模式
type MCPStdioConfig = {
    command: string      // 如 'node'
    args?: string[]      // 如 ['server.js']
    env?: Record<string, string>
}

// 远程 HTTP/SSE 模式
type MCPRemoteConfig = {
    url: string          // 如 'http://example.com/mcp'
    transport?: 'http' | 'sse'   // 默认 'http'
    headers?: Record<string, string>
    auth?: MCPAuthConfig
}

// 联合类型——两种模式二选一
type MCPServerConfig = MCPStdioConfig | MCPRemoteConfig
```

**识别规则**：有 `command` 字段 → stdio；有 `url` 字段 → 远程。通过类型守卫实现：

```typescript
function isStdioConfig(c: MCPServerConfig): c is MCPStdioConfig {
    return 'command' in c
}
```

### Transport 工厂 + Fallback 策略

核心是 `createTransportAndConnect()` 函数，根据配置类型自动选择传输方式：

```
配置类型判断
    │
    ├── isStdioConfig? ──→ StdioClientTransport（本地子进程）
    │
    └── isRemoteConfig?
            │
            ├── transport === 'sse'? ──→ SSEClientTransport（强制 SSE）
            │
            └── 默认 ──→ 先试 StreamableHTTPClientTransport
                            │
                            ├── 成功 → 使用 HTTP
                            └── 失败 → fallback 到 SSEClientTransport
```

为什么要 fallback？因为 MCP 协议有两代远程传输方式：
- **StreamableHTTP** 是新一代推荐协议，支持双向流式通信
- **SSE** 是旧版协议，很多已有 MCP Server 还只支持它
- 自动 fallback 让用户无需关心 Server 用的是哪个版本

### 认证：Headers 注入而非 AuthProvider

MCP SDK 提供了 `OAuthClientProvider` 接口，但它要求实现 9 个方法（redirectUrl、tokens、saveTokens 等），设计目标是浏览器端完整 OAuth 授权码流程。

对 CLI Agent，我们只需要两种简单认证。最终采用 `requestInit.headers` 直接注入 `Authorization` header：

```typescript
function buildAuthHeaders(auth?: MCPAuthConfig) {
    if (auth?.type === 'bearer') {
        return { Authorization: `Bearer ${auth.token}` }
    }
    if (auth?.type === 'client_credentials') {
        const encoded = Buffer.from(
            `${auth.clientId}:${auth.clientSecret}`
        ).toString('base64')
        return { Authorization: `Basic ${encoded}` }
    }
    return undefined
}
```

### 配置示例

```json
{
  "mcpServers": {
    "local-tools": {
      "command": "node",
      "args": ["./tools-server.js"]
    },
    "remote-api": {
      "url": "https://mcp.example.com/v1",
      "auth": { "type": "bearer", "token": "sk-your-api-key" }
    },
    "legacy-sse": {
      "url": "http://internal:8080/sse",
      "transport": "sse",
      "auth": {
        "type": "client_credentials",
        "clientId": "my-agent",
        "clientSecret": "secret-123"
      }
    }
  }
}
```

---

## 深入理解

### 背景与动机：为什么 stdio 不够用？

stdio 模式的本质是**父进程启动子进程**，通过标准输入/输出管道通信。这有三个限制：

1. **必须在同一台机器上**——子进程只能在本地启动
2. **需要安装运行时**——如果 Server 用 Python 写，你的机器得装 Python
3. **无法共享实例**——每个 Agent 会话都启动自己的 Server 进程

HTTP/SSE 传输解除了这些限制：Server 可以部署在任何地方，多个 Agent 共享一个实例，且无需本地安装。

### 类比说明

把 MCP 连接想象成**打电话**：

| 传输方式 | 类比 | 适用场景 |
|---------|------|---------|
| stdio | 面对面说话（同一房间） | 本地工具，开发环境 |
| StreamableHTTP | 视频通话（双向实时） | 现代远程服务 |
| SSE | 收听广播 + 发短信（单向流 + 请求） | 旧版远程服务 |

认证则像**门禁卡**：
- Bearer Token = 一张通行证，直接出示
- Client Credentials = 报上工号和密码，前台验证后放行

### 关键设计决策剖析

#### 1. 为什么用联合类型而非单一类型 + 可选字段？

对比两种方案：

```typescript
// 方案 A：单一类型（所有字段可选）
type MCPServerConfig = {
    command?: string
    url?: string
    transport?: string
    auth?: MCPAuthConfig
}
// 问题：编译器无法阻止同时写 command + url，运行时才报错

// 方案 B：联合类型（本项目采用）
type MCPServerConfig = MCPStdioConfig | MCPRemoteConfig
// 优点：类型守卫缩窄后，编译器知道确切有哪些字段
```

联合类型 + 类型守卫让 TypeScript 在编译期就能检查字段合法性，减少运行时错误。

#### 2. Fallback 时为什么要创建新 Client？

```typescript
// fallback 代码
try {
    const transport = new StreamableHTTPClientTransport(url, opts)
    await client.connect(transport)      // ← 这里失败了
} catch {
    const fallbackClient = new Client(...)  // ← 创建新的！
    const transport = new SSEClientTransport(url, opts)
    await fallbackClient.connect(transport)
}
```

MCP SDK 的 `Client` 在 `connect()` 失败后内部状态可能已损坏（事件监听器已绑定、协议握手半完成）。复用同一个 Client 实例会导致不可预测的行为。

#### 3. 为什么绕过 OAuthClientProvider？

SDK 的 `OAuthClientProvider` 接口：

```typescript
interface OAuthClientProvider {
    redirectUrl: URL
    clientMetadata: OAuthClientMetadata
    clientInformation(): Promise<OAuthClientInformation>
    tokens(): Promise<OAuthTokens>
    saveTokens(tokens: OAuthTokens): Promise<void>
    redirectToAuthorization(url: URL): Promise<void>
    saveCodeVerifier(verifier: string): Promise<void>
    codeVerifier(): Promise<string>
}
```

这是为**浏览器端 OAuth 授权码流程**设计的——需要重定向、PKCE、token 存储等。CLI Agent 不需要这些，直接在 HTTP 请求头里注入凭据就够了。

### 常见误区

| 误区 | 正解 |
|------|------|
| "SSE 和 HTTP 是互斥的" | 不是。SSE 是 HTTP 的一种特殊使用方式（长连接 + 事件流）。StreamableHTTP 是 MCP 定义的新协议规范 |
| "Client Credentials = Basic Auth" | 不完全等同。标准 OAuth 2.0 Client Credentials 流程应该先用凭据换 token，再用 token 调 API。这里简化为直接 Basic Auth，由远端服务决定如何验证 |
| "配置了 auth 会覆盖 headers" | 反过来：自定义 `headers` 的优先级更高，会覆盖 auth 生成的 `Authorization` |

### 设计模式小结

| 模式 | 在哪里用了 | 为什么 |
|------|-----------|--------|
| **联合类型 + 类型守卫** | MCPServerConfig 分 stdio / remote | 编译期安全的配置区分 |
| **工厂模式** | createTransportAndConnect() | 根据配置动态创建不同 transport |
| **优雅降级** | HTTP → SSE fallback | 兼容新旧两代 MCP Server |
| **关注点分离** | buildAuthHeaders 独立于 transport 创建 | auth 逻辑不污染传输逻辑 |
| **Header 注入** | requestInit.headers 替代 AuthProvider | 用最简单的方式解决认证 |

### 一句话总结

> 通过联合类型区分配置、工厂函数分发 transport、Header 注入实现认证——用最小的代码量让 MCP 客户端从"只能连本地"进化为"能连任何地方"。

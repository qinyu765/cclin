# Agent 上下文压缩方案全景调研

> 调研时间：2026-04-23 | 涵盖应用层（Agent 框架）与推理层（KV Cache）两个维度

---

## 一、问题定义

Agent 在长任务执行中不可避免地遇到**上下文膨胀**：

- 工具调用返回大量原始输出（文件内容、搜索结果、日志）
- 多轮对话累积的 token 数超过模型上下文窗口
- 即使窗口够大，"Lost-in-the-Middle" 效应也会导致模型对中间信息的注意力衰减

业界由此发展出 **"Context Engineering"** 这一系统化学科，从 Prompt Engineering 演进而来，核心是最大化上下文的**信噪比**。

---

## 二、应用层方案（Agent 框架级）

### 2.1 滑动窗口（Sliding Window）

| 属性 | 内容 |
|------|------|
| **原理** | 保留最近 N 条消息/token，丢弃最旧内容 |
| **优点** | 实现简单、零额外 LLM 开销、延迟低 |
| **缺点** | 丢失早期关键指令/决策上下文 |
| **适用** | 简单对话型 agent |
| **实现** | 用 `tiktoken` 计数 → 超阈值时删除最老的 user/assistant 对 |

### 2.2 LLM 摘要压缩（Summarization）

| 属性 | 内容 |
|------|------|
| **原理** | 调用 LLM 将旧历史压缩为结构化摘要，替换原始消息 |
| **变体** | 动态摘要（滚动更新）、分层摘要（旧段摘要 + 近段原文） |
| **优点** | 保留语义核心，适合长任务 |
| **缺点** | 有损（细节丢失）、额外 LLM 调用成本 |
| **典型** | Claude Code `/compact`、LangChain `ConversationSummaryMemory` |

### 2.3 Observation Masking（观测屏蔽）

| 属性 | 内容 |
|------|------|
| **原理** | 隐藏/折叠旧的工具返回结果（如冗长的文件内容、搜索结果） |
| **优点** | 不删除信息，只降低噪声 |
| **适用** | 编码型 agent（工具输出是 token 膨胀主因） |

### 2.4 Token Pruning（智能裁剪）

| 属性 | 内容 |
|------|------|
| **原理** | 基于重要性评分移除冗余 / 低价值 token |
| **进阶** | Loss-aware pruning：移除对模型困惑度影响最小的片段 |
| **代表** | LLMLingua-2（Microsoft Research） |

### 2.5 RAG / 选择性检索

| 属性 | 内容 |
|------|------|
| **原理** | 完整历史存入向量数据库，运行时只检索最相关的 chunk 注入 prompt |
| **优点** | 支持海量长期记忆，token 开销可控 |
| **缺点** | 检索质量依赖 embedding 和索引策略 |
| **适用** | 需要跨会话记忆的 agent |

### 2.6 自治式上下文管理（Autonomous Self-Regulation）

| 属性 | 内容 |
|------|------|
| **原理** | 赋予 agent 工具来自主决定何时压缩、存档、检索 |
| **哲学** | 类似 OS 的内存管理——agent 自己做"换页"决策 |
| **代表** | Letta/MemGPT 的 self-editing memory |

---

## 三、主流框架实现对比

### 3.1 Claude Code — 多层级渐进式压缩

Claude Code 拥有业界最成熟的分层压缩管线：

| 级别 | 策略 | 触发条件 |
|------|------|----------|
| L1 | **Snip Compact** — 移除中间旧消息，保留系统 prompt 和近期活动 | 上下文使用率高 |
| L2 | **Microcompact** — Cache-aware 内容缩减，保护 Anthropic Prompt Cache Key | 接近容量限制 |
| L3 | **Auto Compact** — 全对话 LLM 摘要压缩 | ~95% 容量时自动触发 |
| L4 | **Reactive Compact** — 紧急压缩，API 返回 "prompt too long" 时触发 | 最后防线 |
| — | **Staged Collapsing** — 折叠连续工具调用序列 | 工具输出过多 |

> 关键设计：压缩后插入 `SystemCompactBoundaryMessage` 标记，保持审计透明性。

### 3.2 Letta / MemGPT — 操作系统式虚拟内存

将 LLM 上下文窗口类比为 **RAM**，设计三级内存层次：

```
┌─────────────────────┐
│  Core Memory (RAM)  │  ← 始终在上下文窗口中，agent 可自编辑
│  Memory Blocks      │     (Human profile, Persona, 目标...)
├─────────────────────┤
│  Recall Memory      │  ← 完整对话日志存储
│  (Disk Cache)       │     agent 通过搜索工具按需检索
├─────────────────────┤
│  Archival Memory    │  ← 长期文档/经验库
│  (Long-term Store)  │     向量搜索 / 图结构检索
└─────────────────────┘
```

核心机制：**Self-Editing Memory** — agent 通过 tool-use 主动修改自己的 Memory Block。

### 3.3 LLMLingua-2 — 提取式 Token 级压缩

| 属性 | 内容 |
|------|------|
| **出品** | Microsoft Research |
| **原理** | 将压缩视为**提取式 token 分类问题** |
| **模型** | 轻量双向 Transformer (XLM-RoBERTa-large) |
| **压缩比** | 2x–5x，端到端推理延迟降低 2.9x |
| **速度** | 比基于困惑度的方法快 3x–6x |
| **集成** | LangChain / LlamaIndex 中间件 |

### 3.4 Mem0 — 智能记忆抽取层

| 属性 | 内容 |
|------|------|
| **定位** | 框架无关的持久化记忆层 |
| **核心** | Memory Compression Engine — 提取事实/偏好/流程知识 |
| **压缩率** | token 使用量降低约 80% |
| **存储** | 混合架构：向量 + 知识图谱 |
| **优势** | 可插入任意框架（LangChain、AutoGen、纯 API） |

### 3.5 LangChain — 模块化记忆组件

| 组件 | 说明 |
|------|------|
| `ConversationBufferMemory` | 原样保留全部历史 |
| `ConversationSummaryMemory` | 超限时 LLM 摘要 |
| `ConversationSummaryBufferMemory` | 近期原文 + 旧段摘要混合 |
| `VectorStoreRetrieverMemory` | RAG 式按需检索 |
| LangMem SDK (新) | 支持 episodic / semantic / procedural 三类记忆 |

---

## 四、推理层方案（KV Cache 压缩）

> 这一层在模型推理侧工作，对 Agent 开发者通常透明，但理解它有助于选型。

| 技术 | 原理 | 代表 |
|------|------|------|
| **PagedAttention** | 类 OS 虚拟内存分页，消除 KV Cache 碎片 | vLLM |
| **StreamingLLM** | 保留 Attention Sink（首 token）+ 滑动窗口，支持无限长度推理 | MIT/Meta |
| **H2O** | 保留累计注意力最高的 "Heavy-Hitter" token | — |
| **SnapKV** | 无 draft 模型的重要 prompt token 选择 | — |
| **ChunkKV** | 以语义 chunk 而非单 token 为压缩单位 | — |
| **Attention Matching** | 代数方法保留最能代表整体注意力分布的 key，最高 50x 压缩 | — |
| **MLA** | 多头潜注意力，从模型架构层面减少原始 KV Cache 大小 | DeepSeek-V2+ |

---

## 五、推荐混合策略（生产级 Agent）

```
┌──────────────────────────────────────────────┐
│          System Prompt (不可压缩)             │
├──────────────────────────────────────────────┤
│  持久化规则 (CLAUDE.md / 配置文件)            │ ← 每次注入
├──────────────────────────────────────────────┤
│  压缩摘要区 (历史对话的 LLM 摘要)            │ ← 定期更新
├──────────────────────────────────────────────┤
│  RAG 检索区 (按需注入相关上下文)              │ ← 每步检索
├──────────────────────────────────────────────┤
│  近期原文区 (最近 5-10 轮完整消息)            │ ← 滑动窗口
├──────────────────────────────────────────────┤
│  当前轮 (用户输入 + 工具调用)                 │
└──────────────────────────────────────────────┘
```

1. **保留近期原文**用于精确推理
2. **定期压缩旧历史**（在任务边界触发，而非等到爆满）
3. **用 RAG 注入特定事实**
4. **通过 agent 指令触发自压缩**（参考 Claude Code 的自治策略）

---

## 六、选型建议

| 场景 | 推荐方案 |
|------|----------|
| 简单对话 bot | 滑动窗口 + 简单摘要 |
| 编码 agent（如 cclin） | Claude Code 式分层压缩（Snip → Micro → Auto → Reactive） |
| 需要跨会话记忆 | Mem0（框架无关）或 Letta（全托管） |
| Prompt 成本敏感 | LLMLingua-2 前置压缩 |
| 已在 LangChain 生态 | `ConversationSummaryBufferMemory` + `VectorStoreRetrieverMemory` |
| 自研 agent 框架 | 混合策略：滑动窗口 + LLM 摘要 + 事实抽取持久化到本地文件 |

> [!TIP]
> **核心原则**：没有银弹，生产系统几乎都是混合架构。关键是在**信息保真度**和 **token 成本**之间找到平衡点。压缩策略应包含评估框架，持续度量压缩对任务成功率的影响。

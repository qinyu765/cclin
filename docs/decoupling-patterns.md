# 软件解耦模式全景

> 解耦（Decoupling）是软件设计的核心目标之一：让模块之间知道彼此越少越好，变更一方时不波及另一方。本文梳理常见的解耦模式，比较它们的异同，并结合 cclin 项目中的 Hook 系统给出实际映射。

---

## 1. 观察者模式（Observer / Listener）

### 核心思想

**一对多的直接通知**。被观察者（Subject）维护一个观察者列表，状态变化时依次调用所有观察者的回调。

### 结构

```
Subject（被观察者）
  ├── observers: Observer[]
  ├── attach(observer)
  ├── detach(observer)
  └── notify() → 遍历 observers，逐个调用 observer.update()
```

### 特点

| 维度       | 描述                                   |
|------------|----------------------------------------|
| 耦合度     | **中等** — 观察者直接注册在 Subject 上  |
| 通知方式   | 同步，按注册顺序逐个调用                |
| 中间层     | **无** — Subject 直接持有观察者引用      |
| 消息消费   | **广播** — 所有观察者都收到              |

### 生活类比

老师点名提问 → 全班同学（观察者）都听到了问题，每个人都可以举手回答。老师直接面对学生，没有中间人。

### 代码示例

```typescript
class EventEmitter {
    private listeners: Map<string, Function[]> = new Map()

    on(event: string, fn: Function) {
        if (!this.listeners.has(event)) this.listeners.set(event, [])
        this.listeners.get(event)!.push(fn)
    }

    emit(event: string, data: unknown) {
        for (const fn of this.listeners.get(event) ?? []) {
            fn(data)
        }
    }
}
```

### cclin 中的映射

你的 Hook 系统就是观察者模式：
- `HookRunnerMap` = Subject 的观察者列表
- `registerMiddleware()` = `attach()`
- `runHook()` = `notify()`
- 每个 hook handler = 一个观察者

---

## 2. 发布/订阅模式（Pub/Sub）

### 核心思想

**通过中间层（消息总线/频道）间接通知**。发布者和订阅者互相不知道对方的存在，它们只和消息总线交互。

### 结构

```
发布者 A ──→ ┌──────────────┐ ──→ 订阅者 X
发布者 B ──→ │  消息总线      │ ──→ 订阅者 Y
             │  (Event Bus)  │ ──→ 订阅者 Z
             └──────────────┘
```

### 与观察者模式的关键区别

| 维度       | 观察者                   | 发布/订阅                     |
|------------|--------------------------|-------------------------------|
| 耦合度     | 中等（直接注册）          | **低**（通过总线间接通信）     |
| 中间层     | 无                       | **有**（消息总线/Broker）      |
| 发布者是否知道订阅者 | 是（持有引用列表） | **否**（只知道频道名）    |
| 典型场景   | DOM 事件、Vue watch       | Redis Pub/Sub、消息队列        |

### 生活类比

广播电台（发布者）播出节目 → 听众（订阅者）调到对应频道就能收听。电台不知道有多少人在听，听众也不知道电台在哪里——**收音机（消息总线）**是中间桥梁。

### 代码示例

```typescript
// 一个简化的消息总线
class EventBus {
    private channels: Map<string, Function[]> = new Map()

    subscribe(channel: string, fn: Function) {
        if (!this.channels.has(channel)) this.channels.set(channel, [])
        this.channels.get(channel)!.push(fn)
    }

    publish(channel: string, data: unknown) {
        for (const fn of this.channels.get(channel) ?? []) {
            fn(data)
        }
    }
}

// 发布者和订阅者完全解耦
const bus = new EventBus()
bus.subscribe('order:created', (order) => sendEmail(order))   // 订阅者
bus.publish('order:created', { id: 1, total: 99 })            // 发布者
```

### 什么时候用 Pub/Sub 而不是 Observer？

当你需要**跨模块、跨进程、跨服务**通信，且发布者和订阅者不应该直接引用对方时。典型：微服务架构中的事件驱动通信。

---

## 3. 生产者/消费者模式（Producer / Consumer）

### 核心思想

**通过队列做异步任务分发**。生产者把任务放入队列，消费者从队列中取出任务处理。核心特征是**竞争消费**——每条消息只被一个消费者处理。

### 结构

```
生产者 A ──→ ┌────────────────────────┐
生产者 B ──→ │  队列 [task1, task2, …] │ ──→ 消费者 X 拿走 task1
             └────────────────────────┘ ──→ 消费者 Y 拿走 task2
                                           （task1 不会再给 Y）
```

### 与 Pub/Sub 的关键区别

| 维度       | Pub/Sub                    | 生产者/消费者              |
|------------|----------------------------|---------------------------|
| 消费方式   | **广播** — 所有人都收到      | **竞争** — 只一个人处理    |
| 消息是否保留 | 通知完即完成               | **持久化在队列中**直到被消费 |
| 目的       | 通知/事件                   | 任务分发/负载均衡           |
| 处理速度   | 同步或异步均可              | 通常**异步**，有缓冲       |
| 典型技术   | Redis Pub/Sub、EventEmitter | RabbitMQ、Kafka、BullMQ    |

### 生活类比

银行取号排队：客户（生产者）取号后，号码进入队列。多个柜台窗口（消费者）叫号处理，每个号只被一个窗口服务，不会重复叫号。

### 代码示例

```typescript
class TaskQueue<T> {
    private queue: T[] = []

    // 生产者：放入任务
    produce(task: T) {
        this.queue.push(task)
    }

    // 消费者：取出任务（竞争消费，取走就没了）
    consume(): T | undefined {
        return this.queue.shift()
    }
}

const q = new TaskQueue<string>()
q.produce('发送邮件给用户A')
q.produce('生成报表B')

// 消费者 1 拿到 "发送邮件给用户A"
const task1 = q.consume()
// 消费者 2 拿到 "生成报表B"
const task2 = q.consume()
```

---

## 4. 中介者模式（Mediator）

### 核心思想

**用一个中介者对象封装多个对象之间的交互逻辑**。各对象不直接通信，而是通过中介者协调。和 Pub/Sub 不同，中介者通常包含**业务逻辑**，不仅仅是转发。

### 结构

```
组件 A ←──→ ┌──────────┐ ←──→ 组件 C
组件 B ←──→ │  中介者    │ ←──→ 组件 D
             └──────────┘
      （组件之间不直接通信，中介者协调所有交互）
```

### 与 Pub/Sub 的区别

| 维度       | Pub/Sub                  | 中介者                         |
|------------|--------------------------|--------------------------------|
| 中间层职责 | **无脑转发**消息          | 包含**业务协调逻辑**            |
| 通信方向   | 单向（发布 → 订阅）       | **双向**（中介者可以回调组件）  |
| 智能程度   | 哑管道                    | 智能枢纽                       |

### 生活类比

机场塔台（中介者）协调所有飞机（组件）的起降。飞机之间不直接沟通，塔台根据跑道状态、天气等**业务逻辑**决定谁先降落。

### 代码示例

```typescript
class ChatRoom {
    private users: Map<string, User> = new Map()

    register(user: User) {
        this.users.set(user.name, user)
    }

    // 中介者包含路由逻辑，不只是转发
    send(from: string, to: string, message: string) {
        const target = this.users.get(to)
        if (target) {
            target.receive(from, message)
        } else {
            console.warn(`用户 ${to} 不在线`)
        }
    }
}
```

---

## 5. 依赖注入（Dependency Injection）

### 核心思想

**不自己创建依赖，而是从外部"注入"进来**。模块只声明"我需要什么"，不关心"怎么来的"。这是对**创建型耦合**的解耦。

### 结构

```
// 紧耦合（自己创建依赖）
class Agent {
    private llm = new OpenAIClient('gpt-4')  // 硬编码，无法替换
}

// 依赖注入（外部传入）
class Agent {
    constructor(private llm: LLMClient) {}   // 只依赖接口，实现可替换
}
```

### 解耦的维度

其他模式解耦的是**通信**（谁通知谁），DI 解耦的是**创建**（谁负责实例化）。

| 维度     | 事件型模式（Observer/Pub-Sub） | 依赖注入             |
|----------|-------------------------------|---------------------|
| 解耦目标 | 运行时通信                     | 构建时依赖创建       |
| 典型场景 | 事件通知、消息广播              | 替换实现、测试 mock  |

### cclin 中的映射

```typescript
// buildHookRunners 就是一种依赖注入：
// 把外部传入的 hooks 和 middlewares 注入到系统中
const runners = buildHookRunners(hooks, middlewares)
```

调用者决定注入什么 handler，`buildHookRunners` 本身不知道具体实现。

---

## 6. 策略模式（Strategy）

### 核心思想

**定义一系列算法，把每个算法封装成独立对象，使它们可以互相替换**。调用者只依赖统一接口，运行时选择具体策略。

### 结构

```typescript
interface CompactStrategy {
    compact(history: ChatMessage[]): Promise<ChatMessage[]>
}

class LLMCompact implements CompactStrategy {
    async compact(history) { /* 调用 LLM 总结 */ }
}

class TruncateCompact implements CompactStrategy {
    async compact(history) { /* 简单截断前 N 条 */ }
}

// 使用时注入不同策略
function runSession(strategy: CompactStrategy) {
    const compacted = await strategy.compact(history)
}
```

### 与依赖注入的关系

策略模式通常**配合依赖注入使用**——策略对象作为依赖被注入到使用者中。DI 是"怎么传进去"，Strategy 是"传进去的东西遵循什么接口"。

---

## 全景对比

| 模式 | 关系 | 中间层 | 通信方向 | 消息消费 | 解耦维度 | 一句话 |
|------|------|--------|----------|----------|----------|--------|
| 观察者 | 1→N | 无 | 单向推送 | 广播 | 运行时通信 | 直接通知所有监听者 |
| 发布/订阅 | 1→N | 消息总线 | 单向推送 | 广播 | 运行时通信 | 通过频道间接通知 |
| 生产者/消费者 | 1→1 | 队列 | 单向推送 | 竞争消费 | 运行时通信 | 任务排队，逐个分发 |
| 中介者 | N↔N | 中介者 | 双向 | 路由转发 | 运行时交互 | 中央协调器管理所有交互 |
| 依赖注入 | 1←1 | 容器/工厂 | 构建时 | — | 创建型依赖 | 不自己 new，外部传入 |
| 策略 | 1←N可选 | 无 | 调用时 | — | 算法可替换 | 同一接口，不同实现 |

---

## 选择指南

```
需要通知多个监听者？
├── 是 → 监听者需要知道发布者吗？
│       ├── 可以 → 观察者模式
│       └── 不行 → 发布/订阅
├── 需要任务排队和负载均衡？ → 生产者/消费者
├── 多个对象互相需要协调？ → 中介者
├── 想让实现可替换、方便测试？ → 依赖注入 + 策略模式
```


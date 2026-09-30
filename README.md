from pathlib import Path

content = """# Context Hygiene Harness

一个面向 ChatGPT 长对话的上下文健康监测工具。

项目通过浏览器扩展持续收集 ChatGPT 对话，将已观察到的消息持久化到本地 SQLite，并对当前 Conversation 的上下文规模、纠正行为与废弃方案等信号进行分析，输出：

- GREEN
- YELLOW
- RED

帮助用户判断当前聊天是否仍适合继续工作，或是否应该考虑切换到新的对话窗口。

> 当前版本为 MVP。Conversation 持久化、浏览器扩展、多标签页隔离和基础 Context Monitor 已完成；更精细的上下文退化检测将在 Monitor V2 中继续研发。

---

## 为什么做这个项目

在长期使用 ChatGPT 进行开发、学习和复杂项目讨论时，一个聊天窗口可能逐渐积累：

- 大量历史消息
- 已经废弃的旧方案
- 多轮 Debug 记录
- 用户对 AI 的反复纠正
- 与当前任务关联较弱的早期上下文

长上下文本身并不一定意味着模型已经失效，但随着历史不断累积，可能增加遗忘、重复、旧方案混淆以及上下文污染的风险。

Context Hygiene 的目标不是简单做“字符数警报器”，而是建立一个可以持续演进的 **Conversation Context Observability Harness**。

---

## 当前功能

### ChatGPT Conversation Reader

浏览器 Content Script 持续观察 ChatGPT 页面中的消息：

- 区分 user / assistant
- 提取 message key
- 识别 conversation ID
- 支持 ChatGPT 项目页面和普通 Conversation
- 处理页面 DOM 虚拟化
- 同一消息优先保留更完整版本
- 不同 Conversation 独立缓存

DOM 只作为观察来源，不作为长期事实源。

### Shared Conversation Store

聊天记录持久化到本地 SQLite：

```text
Conversation
    │
    ├── Message
    ├── Message
    └── Message
```

通过：

```text
conversation_id + message_key
```

标识同一 Conversation 中的一条消息。

数据库合并规则：

```text
新 message key
→ INSERT

已有 message key + 新正文更长
→ UPDATE

已有 message key + 新正文变短
→ 保留数据库中的更完整版本
```

因此 ChatGPT 页面刷新、DOM 虚拟化或历史消息暂时消失，不会直接删除已经收集的历史。

### Context Monitor

当前 MVP 使用透明的规则进行基础判断，包括：

- Conversation 消息数量
- Conversation 字符数量
- 用户多次纠正 AI
- 多个已废弃方案

输出：

```text
GREEN
YELLOW
RED
```

当前规则属于 Baseline。

后续 Monitor V2 将重点研究：

- 上下文压力
- 连续性退化
- 旧方案混淆
- 当前任务相关性下降
- 基于真实失败行为的 Context Rot Detection

### Browser Popup

浏览器工具栏直接显示：

```text
G / Y / R
```

点击扩展后可以查看：

- 当前 Context 状态
- 已收集 Messages 数量
- Characters 数量
- 风险原因
- 是否建议切换 Conversation

不同 ChatGPT 标签页拥有独立状态。

---

## 架构

```text
ChatGPT Web Page
       │
       ▼
Conversation Reader
       │
       ▼
Extension Worker
       │
       ▼
FastAPI /sync
       │
       ▼
Shared Conversation Store
       │
       ▼
SQLite
       │
       └──────────────► Context Monitor
                              │
                              ▼
                        GREEN/YELLOW/RED
                              │
                              ▼
                         Badge / Popup
```

模块职责：

```text
Reader
= 观察 ChatGPT 页面

Worker
= 浏览器扩展后台协调

Conversation Store
= 长期保存 Conversation

SQLite
= 本地事实源

Context Monitor
= 判断上下文健康度

Popup
= 用户界面
```

---

## 项目结构

```text
desktop-pet-harness/
│
├── shared/
│   ├── chatgpt_bridge/
│   │   ├── manifest.json
│   │   ├── conversation_reader.js
│   │   ├── bridge_worker.js
│   │   ├── popup.html
│   │   ├── popup.js
│   │   └── popup.css
│   │
│   └── conversation_store/
│       ├── __init__.py
│       ├── database.py
│       └── store.py
│
├── plugins/
│   └── context_hygiene/
│       ├── requirements.txt
│       └── backend/
│           └── app/
│               ├── __init__.py
│               ├── main.py
│               ├── schemas.py
│               └── context_monitor.py
│
├── tests/
├── tests_js/
├── scripts/
├── data/
├── .gitignore
└── README.md
```

---

## 本地运行

### 1. 创建 Python 环境

项目当前基于 Python 3.12。

```powershell
cd D:\\study\\desktop-pet-harness
py -3.12 -m venv .\\plugins\\context_hygiene\\.venv
```

安装依赖：

```powershell
.\\plugins\\context_hygiene\\.venv\\Scripts\\python.exe -m pip install -r .\\plugins\\context_hygiene\\requirements.txt
```

### 2. 启动 FastAPI

在项目根目录运行：

```powershell
.\\plugins\\context_hygiene\\.venv\\Scripts\\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --app-dir .\\plugins\\context_hygiene\\backend
```

健康检查：

```text
http://127.0.0.1:8000/health
```

Swagger：

```text
http://127.0.0.1:8000/docs
```

### 3. 安装 Edge 扩展

打开：

```text
edge://extensions
```

开启开发人员模式，选择“加载解压缩的扩展”，并选择：

```text
shared/chatgpt_bridge
```

不要选择整个项目根目录。该目录中必须直接存在 `manifest.json`。

---

## 数据隐私

Conversation 原文只保存在本机 SQLite：

```text
data/conversations.db
```

数据库文件已被 `.gitignore` 排除。

不要将真实聊天数据库提交到公开 GitHub 仓库。

以下文件同样不会进入版本控制：

```text
.venv/
.env
*.db
*.db-wal
*.db-shm
__pycache__/
.pytest_cache/
```

---

## 当前限制

### ChatGPT DOM 依赖

Reader 当前依赖 ChatGPT Web DOM 中的：

```text
data-content-search-unit-key
```

ChatGPT 网页结构变化可能导致 Reader 需要适配。

### 历史 Conversation

Reader 只能收集：

- 已经被页面加载过的消息
- 插件运行期间观察到的消息

对于一个从未完整加载过的旧 Conversation，MVP 不保证立即恢复全部远古历史。

### Message Key

部分 ChatGPT 页面可能使用：

```text
fallback-turn-*
```

类型的临时 message key。

当前 MVP 已实现 Conversation 隔离和正文防缩水，但这些 key 的长期稳定性仍需要持续验证。

### Monitor V1

目前 GREEN / YELLOW / RED 仍属于启发式规则。

长 Conversation 不等价于 Context Rot。

Monitor V2 将建立独立 Evaluation Set，并基于真实退化行为重新设计判断逻辑。

---

## Roadmap

### MVP

- [x] ChatGPT Reader
- [x] Conversation 隔离
- [x] DOM 虚拟化防缩水
- [x] Extension Worker
- [x] FastAPI
- [x] SQLite Conversation Store
- [x] Message Merge / Upsert
- [x] 多标签页支持
- [x] Browser Badge
- [x] Popup
- [x] 基础 Context Monitor
- [x] Python / JavaScript 测试

### Monitor V2

- [ ] Context Hygiene Evaluation Set
- [ ] 连续性退化检测
- [ ] 旧方案混淆检测
- [ ] Relevance Dilution
- [ ] Context Pressure Calibration
- [ ] Context Rot Evidence
- [ ] Personalized Threshold

### Desktop Pet Harness

未来计划将 Context Hygiene 作为 Desktop Pet Host 的一个插件：

```text
Desktop Pet Host

├── Shared ChatGPT Bridge
├── Shared Conversation Store
│
├── Context Hygiene
├── Learning Timer
└── Future Plugins
```

---

## 设计原则

**DOM is observation, not truth**

ChatGPT DOM 只是观察来源，已经持久化的 Conversation 才是长期事实。

**Evidence before complexity**

MVP 先使用透明规则，Monitor V2 在 Evaluation 和真实数据基础上演进。

**Shared infrastructure first**

ChatGPT Reader 和 Conversation Store 属于共享基础设施，而不是 Context Hygiene 插件的私有实现。

**Keep the MVP small**

当前版本没有引入 Redis、RAG、Vector DB、Multi-Agent、Event Bus 或复杂 Plugin Runtime。

先完成可靠的数据闭环，再逐步扩展。

---

## Status

Context Hygiene MVP：**可运行 / 持续迭代中**

下一阶段：**Context Monitor V2 + Evaluation**
"""

path = Path("/mnt/data/README_context_hygiene_clean.md")
path.write_text(content, encoding="utf-8")
print(path)

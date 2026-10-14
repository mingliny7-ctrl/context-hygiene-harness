# Conversation Atlas · 真实数据首个切片

默认读取现有 Conversation Store。视觉基线仍为暂定，完成本轮后等待真实数据 UI 验收。

## 启动

在仓库根目录运行 `./scripts/start_atlas.ps1`，访问 <http://127.0.0.1:4173/>。复用已有 Python 环境的 FastAPI/uvicorn，只启动独立 Atlas，不调用 Monitor。

备用命令：
```powershell
.\plugins\context_hygiene\.venv\Scripts\python.exe -m uvicorn plugins.conversation_atlas.backend.main:app --host 127.0.0.1 --port 4173
```

真实模式不能再用静态 http.server：它没有 API。数据库默认 `data/conversations.db`，沿用既有 `CONVERSATION_DB_PATH` 环境变量。数据库不存在 / schema 不兼容返回503，不创建或迁移库。按 Ctrl+C 停止服务。

## 当前数据与交互

- 所有会话进入虚拟“未分类”组；Segment 数组为空，分类 / 阶段 / 结论明确未处理。
- Conversation ID 等于数据库 conversation_id；标题从首条非空用户消息截取，原文摘录不是 AI 摘要或 ChatGPT 官方标题。
- 点击会话异步读取详情；点击原文预览 / 查看全部打开本地消息弹窗，用消息键选择器定位具体记录。
- 消息身份为 (conversation_id, message_key)。完整正文通过 textContent 展示，空正文保留并提示未采集内容，不执行原文 HTML。
- 排序为首次观察时间 + SQLite rowid，未宣称原始顺序；时间为首次入库 / 最近同步，未宣称 ChatGPT 原始创建时间。
- 搜索仅匹配已加载标题、摘录、ID，不是全文或语义搜索。
- 空库、字段缺失、HTTP / JSON / 网络错误有明确状态；失败不回退 Mock。过期详情请求取消，避免快速切换串会话。
- 原粒子、布局、曲线、Inspector关闭和返回保留。演示模式仅通过 <http://127.0.0.1:4173/?source=demo> 显式开启，清楚标为演示数据。

## 契约与独立性

原链路：Reader → Bridge Worker → 现有 /sync → Shared Store / SQLite。
新增链路：同一个 SQLite → Shared Store 只读查询 → 独立 Atlas API → 原前端图谱。
Atlas 不导入 Monitor，不使用健康评分，不更改 Reader、Worker、Monitor 或原写入逻辑。

- GET /api/atlas：schemaVersion=1、provenance.mode=real、categories / conversations / segments、quality计数。分类当前仅虚拟组，阶段为空。节点包含原 ID、原文摘录、UTC ISO 时间或null、messageCount、totalChars、previewMessageKey、未处理状态和质量信息。
- GET /api/atlas/conversations/{conversation_id}：相同conversationId、原始key / role / content / firstSeenAt / updatedAt数组。404为不存在，503为库不可读。
- SQLite连接 mode=ro + query_only=ON；不调用init_db、不写原始数据。页面与接口no-store，不向外部模型发送数据。

以上端点、字段和 loadAtlas / loadConversation / get_read_connection / list_stored_conversations / read_stored_conversation 属于【🟢 本地自定义名称】及项目契约；sqlite3.connect / FastAPI / StaticFiles / fetch / AbortController 属于【🔒 官方固定 API】。

## 文件与测试

backend/main.py负责独立API和同源页面；data/atlas-source.mjs负责来源 / 契约 / 错误；app.mjs接入真实状态和异步详情；messages.mjs负责原文定位；index.html/styles.css仅增加来源与原文样式。layout.mjs、particles.mjs本轮未改。

```powershell
.\plugins\context_hygiene\.venv\Scripts\python.exe -m pytest -q
node --test plugins/conversation_atlas/frontend/tests/data.test.mjs plugins/conversation_atlas/frontend/tests/layout.test.mjs plugins/conversation_atlas/frontend/tests/particles.test.mjs plugins/conversation_atlas/frontend/tests/real-source.test.mjs
```

## 限制

2026-10-14快照：7条存储会话、238条消息，含1个test-前缀ID及3条测试消息。其余6个ID合计235条消息。38条正文为空，235条fallback键，两个不同ID的已观察正文完全相同。物理/外键检查正常，不代表历史完整、键永久稳定或路由归属全部正确。

修复建议：验证ChatGPT原生消息ID、路由切换归属；增加Reader版本、原始顺序与完整性证据；先保存跨会话相同转录最小复现。不静默去重、不补写空正文、不把观察顺序当原始顺序；历史迁移/回填另行确认。

未实现AI分类、摘要、Segment、全文/语义索引、删除恢复及ChatGPT网页内精确跳转；只定位本地已存储原文。不声称恢复完整历史。详见STATUS.md和本轮验收报告。

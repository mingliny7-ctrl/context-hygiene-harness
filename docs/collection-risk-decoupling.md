# Module 1 — 采集与风险检测解耦（2026-10-15）

基线 `264e00e`。产品取消上下文风险检测；本轮仅切断采集服务对其运行依赖。

## 审计与最小改动

原 `create_app` 初始化 ContextMonitor；`/sync` 先提交 Store 再调用 `build_status`→Monitor.analyze，分析异常可能让已提交的采集返回500。`/status` 同样分析。Worker固定请求 `http://127.0.0.1:8000/sync`，以返回风险状态更新缓存与徽章；Popup还会恢复旧风险缓存。

Shared Store与schema不依赖Monitor；Reader也不调用评分。无需建立新服务、复制Reader或拆目录。

修改后：ChatGPT页面→原Reader→原Worker→原`/sync`→原Store→SQLite提交→返回存储回执。采集API不导入、不初始化、不调用Monitor。

## 文件与契约

|文件|变化|
|---|---|
|`plugins/context_hygiene/backend/app/main.py`|移除Monitor执行依赖，按已保存消息生成回执；旧`/analyze`返回410；原路由及启动路径保留|
|`plugins/context_hygiene/backend/app/schemas.py`|ConversationSyncResponse不再继承ContextHealth，status为SAVED|
|`shared/chatgpt_bridge/bridge_worker.js`|SAVED显示中性S徽章；旧风险缓存不恢复为当前状态；后端地址、队列、消息写入协议不变|
|`shared/chatgpt_bridge/popup.js`、`popup.html`|显示“已保存”和采集数量；不展示旧风险分数或换窗建议；明确采集不代表完整对话|
|`tests/test_api.py`|Monitor构造/分析同时抛错时，采集、状态恢复和旧接口停用仍符合契约|
|`tests/test_conversation_identity.py`|独立后端进程禁止导入Monitor，仍验证真实Reader/Worker源码→HTTP→SQLite、三次同步、重启与Atlas|
|`tests_js/worker.test.js`、`popup.test.js`|验证采集回执、旧评分不显示、旧请求失败不污染新tab徽章；纠正原Popup URL fixture字面尖括号|
|`tests_js/reader.test.js`|仅纠正manifest host permission测试fixture的字面尖括号，Reader源码未动|
|`README.md`、本文|记录新产品决策、接口变化和验证边界|

采集回执：

```json
{"conversation_id":"<正式ID>","message_count":3,"total_chars":92,"status":"SAVED","reasons":[],"should_handoff":false}
```

`message_count`为库内已观察记录数，不是对话完整性证明。reasons/should_handoff是为已有扩展保留的固定空值/false字段，未做风险计算。GET状态路由保留，含义变为存储回执；依赖GREEN/YELLOW/RED的外部消费者需要更新。context_monitor.py、ContextHealth等旧实现仍可回溯，但采集服务不会加载它。历史规则单元测试仍直接测试该旧代码，区别于采集运行路径。

## 实际验证

- Python 28通过，1条既有Starlette/httpx弃用警告。
- 扩展JS 12通过，Atlas前端25通过，合计37通过、0失败。
- 独立后端进程将`sys.modules['app.context_monitor']=None`，仍启动、接收真实Reader/Worker源码的HTTP请求；三次重复同步无新增，进程28300退出后进程8020读取相同SQLite。Atlas现有图谱和详情API精确返回原文。
- 真实Edge/ChatGPT新聊天发送唯一标记 `ATLAS_COLLECTOR_DECOUPLE_20261015_001`，真实回复“采集服务验证完成。”。正式Conversation ID `6ad021b1-7870-83ec-baa6-283b38d09727`。
- 已安装扩展日志确认正式ID发送；后端POST成功，SQLite和API原文一致。旧Reader还发送了一次临时ID，后端409拒绝，临时ID没有入库，身份防护保持有效。
- 真实页面重新加载再次自动同步，仍1 Conversation/3 Messages，正文哈希一致。其中1条空Assistant是已有采集边界，本轮没有修复或删除。
- 真实采集后端PID42892停止，确认8000端口解除监听；停止期间只读SQLite仍可见标记。以同命令启动PID40500，状态恢复为SAVED，Atlas4173原文详情精确匹配全部3条记录。
- 初次、重复、停止、重启阶段正文SHA256均为 `cc8b3dc3835e5ddd1b7d439c9d9f7964587adceadd4109f17b9c54e198dde088`。
- 当前真实数据库 `D:\study\desktop-pet-harness\data\conversations.db`，从本轮浏览器测试前15 Conversations/309 Messages增加至16/312，仅新增正式测试对话3条消息。schema哈希仍为 `b9b1a898767c15ca697b31311cc1438353acf792c8ddbe9c7b101e3bc1edad3f`，无迁移、清库或手工历史改写。

真实浏览器使用当时已安装版本的Reader/Worker，尚未重新加载更新后的扩展；这证明现有采集链可使用新后端。新版徽章和Popup已通过源码单元测试，其实际浏览器显示需在Edge扩展管理页重新加载现有Bridge后验证。不把这部分声称为已做实机验收。

## 启动与检查

在 `D:\study\desktop-pet-harness` 运行原命令：

```powershell
.\plugins\context_hygiene\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --app-dir .\plugins\context_hygiene\backend
```

健康检查：`GET http://127.0.0.1:8000/health`。`/sync`是POST入口，浏览器地址栏GET该地址返回405是正常行为。

Atlas现有访问地址：`http://127.0.0.1:4173/`；原文API `/api/atlas/conversations/{id}`。无需为Atlas启动Reader或Monitor。

```powershell
.\plugins\context_hygiene\.venv\Scripts\python.exe -m pytest tests -q -s
node --test tests_js/*.test.js plugins/conversation_atlas/frontend/tests/*.test.mjs
```

本轮没有改Reader、Store、Monitor旧算法、SQLite schema或Atlas代码，没有自动滚动、AI调用、Segment或历史清理。停止于本模块，等待验收后再进入Module 2。

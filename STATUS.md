# Conversation Atlas · 第二阶段首个集成切片 · 2026-10-14

状态：真实Store→独立Atlas API→图谱→原文消息键定位已完成。视觉仍为暂定基线；停止扩展，等待真实数据UI验收。

## 检查点与修改边界

开始前工作区干净，HEAD=c2df4eb。已保存带注释标签atlas-ui-baseline-20261014，不覆盖用户工作。当前分支feat/conversation-atlas-prototype；本轮提交及清单见阶段二Git记录。

新增独立Atlas API和同源静态页面，共享Store新增只读连接/查询。原Store写入函数、Monitor、Reader、Worker、layout.mjs、particles.mjs未改。没有表变更、迁移、删除、历史补写、AI调用或新增数据库事实源。

## 真实数据与证据

来源：D:/study/desktop-pet-harness/data/conversations.db。
conversations主键conversation_id；messages主键(conversation_id,message_key)，外键关联会话，包含role/content/first_seen_at/updated_at。

7条持久化会话、238条消息，含test-conversation-1及3条测试消息；其余6个ChatGPT形式ID合计235条消息。user118/assistant120；38条空正文，235条fallback-turn键，0空键，0孤立消息。quick_check=ok，外键0违规。

两条不同ID的已观察正文完全相同；21组first_seen_at并列。Store明确只保证首次观察顺序，没有完整性、原始时间、官方标题或AI结果字段。因此不能宣称已恢复完整历史或所有路由归属正确。

开发前后全表逻辑SHA256均为7fb0e9f45d5b6f23651742232a50915c024f0ffa286c12cc5414ac21c7eb9933。

原链路：Reader观察DOM→Worker POST现有/sync→Shared Store合并。短正文不覆盖长正文，缺席不删除；fallback键永久稳定性未验证。审计时8000端口未启动，Atlas读取已有库，不假装新采集成功。

采集修复建议：验证ChatGPT原生消息ID与路由切换归属；补充Reader版本、原始顺序、完整性证据；先保存相同转录最小复现。不静默去重、补写空正文或改写顺序。历史迁移/回填另行确认。

## 最小契约与运行链路

GET /api/atlas返回schemaVersion=1、real来源、虚拟未分类组、原Conversation ID/摘录/质量计数；Segment为空。GET /api/atlas/conversations/{id}返回相同ID的原始key/role/content/观察时间。

SQLite mode=ro和query_only=ON，不调用init_db；缺库/坏schema/不可读503，不存在会话404。接口失败显示错误和重试，不回退Mock。详情取消旧请求，防止串会话；原文入口位于标题后，弹窗可按真实消息键定位。原文用textContent展示，空正文保留缺失提示。

标题为原文截取，不是官方标题；摘录不是AI摘要；时间标为首次入库/最近同步；顺序仅为首次观察顺序。分类、阶段、结论未处理。搜索仅加载的标题/摘录/ID。演示仅通过/?source=demo显式开启。

## 验证

- Python21通过（原11+Atlas10），1个既有Starlette/httpx警告。
- Atlas前端25通过（原19+真实来源6）。
- 原扩展JS5通过/3失败，与基线相同：popup.test.js:57、:81；reader.test.js:126，既有URL/host permission尖括号相关断言；本轮未改。
- 两个独立PID启动同一真实库，7个ID及全部238条key/role/content逐条一致，重启前后快照一致。
- 写入被SQLite拒绝，缺库不创建文件、坏schema不迁移；原写入功能回归通过。
- 浏览器实测真实节点/异步详情/原文key定位/消息切换/Esc关闭/关闭详情保留图谱/返回/ID搜索/快速选择/空库/503/恢复重试，以及显式Demo阶段交互。
- 缺失标题/日期、空消息、缺失/重复ID、父子关系、网络/JSON/HTTP错误有自动测试。
- 真实页面0 error/warn；503测试页初始化错误为预期。

真实业务成功证据来自真实库重启和全量逐条比较。空库/错误夹具只用于异常测试，位于对话work目录，不计入业务记录。

## UI问题与建议

未分类首页比演示稀疏，未伪造分类；相似标题增加短ID区分。7个纵向会话在矮窗口需滚动，后续可按验收反馈调间距。窄屏沿用覆盖式Inspector，需关闭后访问被覆盖的右侧Segment。原文入口已从底部上移，便于发现。本轮不重设计整体布局。

## 启动与未实现

在仓库根目录运行./scripts/start_atlas.ps1，访问http://127.0.0.1:4173/。独立服务复用现有Python依赖，不需要Monitor启动。静态http.server不再支持真实模式。

未实现采集修复、历史补全、AI分类/摘要/Segment、全文/语义索引、删除恢复、ChatGPT网页内精确定位或大规模性能优化。仅定位本地已存储原文。完成此切片后停止扩展，等待UI验收。

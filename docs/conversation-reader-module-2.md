# Module 2 — Conversation Reader 稳定性与 Popup 反馈

基线：`db5e27e`。当前日期2026-10-15。采集仍为手动滚动页面、原扩展自动观察；没有自动滚动、第二套Reader、风险分析、模型API、Segment或Atlas视觉修改。

## 已确认的根因

1. **隐藏的旧SPA页面被全局读入。** 实际Edge侧边栏执行A→B→A→C后，DOM保留多个`data-app-shell-active-page=false`容器。旧Reader全局读取所有`data-content-search-unit-key`，不同对话共用fallback-turn-0键；B的4个DOM单元只发2条，C路由变化时先发2条旧内容再发10条。首个偏差在Reader范围与身份选择，Store与Atlas互相匹配。
2. **流式占位的DOM位置不是消息身份。** 实际DOM提供`data-chatgpt-search-message-ids`（User在父级，Assistant在自身，重复相同UUID需去重）和`data-talvt-turn-state`。旧代码忽略它们，会让空占位与最终回答成为不同key。
3. **发送调度和反馈缺少确认语义。** 全body trailing debounce会被持续mutation重置，受控时钟测试确认；Popup计数包含User与空Assistant，断开时还能显示缓存SAVED。旧任务也可能更新切换后的tab映射。
4. **重载扩展不等于所有已打开页面已加载新版脚本。** 用户报告重载后仍不可用时，实际当前页日志仍是旧格式且SQLite没有native key。确认没有未发送输入或活动生成后刷新该页，原始ID记录从0增加到4条（2条Assistant）。不能只根据扩展管理页显示已重载判断运行版本。

后端在基线故障期间正常监听，无证据把本次问题归因于上一轮进程退出，没有做生命周期重构。

## 最小修改与数据流

活动页→正式Conversation ID与活动容器绑定→读取平台消息UUID/role/完成状态→按Conversation缓存已完成原文→Worker校验来源、串行同步→原`/sync`→原Store事务→SQLite→确认回执→Popup。

- Reader只读取唯一活动页；已绑定A的容器不会在URL先变成B时被认作B。每次重新查容器，不保留旧DOM节点列表；Observer监听documentElement及活动页/身份/完成状态属性。
- 原始UUID保存在既有message_key中，格式`chatgpt:<uuid>:<role>`。未知、多义身份不猜测；Assistant需明确complete且正文非空才发布。非空streaming正文也不会作为正式回答写入，因此不是仅过滤空字符串。
- 已发现的完成消息按Conversation累积，离开DOM不删除；定时检查和有界throttle避免等待永久安静。导航版本保护旧回调，Worker保护tab映射与较新回执。
- Worker拒绝仍在运行的旧Reader协议，提示刷新该页面，避免旧fallback观察继续污染历史；只在后端确认后显示SAVED。
- Store保留全部旧数据，不迁移或合并fallback行。只有能证明原始ID唯一的非空Assistant才给出确定总数；混有旧fallback时总数null，同时提供已确认原始ID的回复子集数量。
- Popup标题来自匹配当前Conversation URL的真实页面侧边栏标题，无标题时等待，不截取问题冒充标题。显示“正在采集/已保存/未连接/保存失败”；跟随SPA导航并定期检查后端。字符数展示及专用计算已移除。

这些`assistant_reply_count`、`confirmed_assistant_reply_count`、`count_status`均为【本地自定义字段】，不是OpenAI SDK字段。网页`data-*`是当前实际观察到的DOM属性，不是承诺永久稳定的官方SDK契约。

## 验证状态

|场景|状态与证据|
|---|---|
|旧故障回归|PASS：同3项测试对db5e27e Reader全部失败，对修改后全部通过，保留红/绿日志|
|自动化|PASS：Python29项，JS44项（扩展19+Atlas25）；保留1条既有Starlette/httpx弃用警告|
|真实三对话SPA|PASS身份：A=6ad021b1-7870-83ec-baa6-283b38d09727 → B=6acf6b04-65a0-83ec-9cec-19f2a7c33074 → A → C=6ab523fd-3fc0-83ec-a28b-ee7549dc7e47；最新各页原始ID/正文SHA256与SQLite、Atlas一致|
|早期A正文快照|UNVERIFIED：首次观测长度7的正文哈希与后续库内长度9正文不同；A返回后的9字正文精确匹配。未保留早期文本，无法确认差异具体成因，未将该首次快照算作逐字通过|
|手动上下滚动与原生Popup|PASS（用户手工确认）：用户最后明确“没有问题，继续”；工具未代滚动、未直接读取原生Popup。C之后仍观测10个原始ID单元，旧完成消息仍在库；没有证据宣称额外历史一定加载或整段采集完整|
|新对话回复与计数|PASS：真实ChatGPT发送ATLAS_READER_MODULE2_20261015_001；Conversation 6ad07a99-6328-83ec-a2ed-831fdeaa13fc；1 User+1 Assistant，无空Assistant，确定回复数1|
|真实刷新去重|PASS：新对话刷新后仍2条消息、1条有效Assistant，原始ID和正文哈希不变|
|真实后端重启|PASS：31520完全停止，8000不监听；停机期间只读SQLite数据仍存在，8940启动后回执仍为1，正文哈希一致|
|同正文不同对话|PASS受控HTTP/SQLite测试；三个真实新聊天具有完全相同正文的场景未单独执行，UNVERIFIED|
|流式中间态|PASS受控测试：非空streaming不保存，改fallback key但UUID相同只产一个完成回答；真实新回答最终仅1 Assistant。真实逐阶段流式DOM采样UNVERIFIED|
|后端断开反馈|PASS单元测试与真实停机磁盘验证；原生Popup在停机瞬间的显示未由工具采样，UNVERIFIED|
|扩展管理自动操作|BLOCKED：工具仅允许http/https，拒绝edge://extensions；用户手动重载完成，没有绕过安全策略|

旧Conversation总回复数仍可能为“暂不可用”，但会显示“已确认保存X条原始ID模型回复，旧总数未知”。不能把子集X冒充全库去重总数。旧fallback原文仍由Atlas返回，本轮没有删除它们。

## 修改文件

- `shared/chatgpt_bridge/conversation_reader.js`：活动页、原始ID、完成态、有界调度与导航隔离。
- `shared/chatgpt_bridge/bridge_worker.js`：来源与协议校验、异步状态保护、回执确认与旧脚本刷新提示。
- `shared/chatgpt_bridge/popup.js`、`popup.html`：真实标题、有效回复统计、四类保存状态，移除字符数。
- `shared/conversation_store/store.py`：新增只读统计纯函数，原写事务和查询原文保持不变。
- `plugins/context_hygiene/backend/app/main.py`、`schemas.py`：采集回执增加确定/已确认回复数与可靠性，删除total_chars。
- `tests_js/reader-stability.test.js`、`reader.test.js`、`worker.test.js`、`popup.test.js`、`fixtures/identity_capture.cjs`：真实DOM模型与回归。
- `tests/test_api.py`、`test_store.py`：新回执和不猜测旧身份的统计。
- `README.md`、本文：契约、边界与验收记录。

没有schema变更，未需要迁移或清理；SQLite绝对路径仍是`D:\study\desktop-pet-harness\data\conversations.db`。原Monitor源码与Atlas源码没有修改。total_chars从采集响应移除，依赖该旧字段的第三方客户端需更新；Atlas独立契约不受影响。

## 重现与运行

仓库根目录执行：

```powershell
.\plugins\context_hygiene\.venv\Scripts\python.exe -m pytest tests -q -s
node --test tests_js/*.test.js plugins/conversation_atlas/frontend/tests/*.test.mjs
.\plugins\context_hygiene\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --app-dir .\plugins\context_hygiene\backend
```

修改扩展后，重载原有Bridge，并完整刷新每个要采集的ChatGPT页。已打开但未刷新的旧上下文会被明确拒绝。只允许用户手动滚动。

计数核验：`GET /conversations/{id}/status`；Atlas原文：`http://127.0.0.1:4173/api/atlas/conversations/{id}`。

## 尚存边界

未承诺所有ChatGPT DOM版本都支持。若平台不再提供唯一活动容器/消息ID/完成状态，宁可等待确认，不退回正文或位置推测归属。活动页容器被框架跨Conversation复用的其他实现尚未实测。

原消息编辑、重生成、分支与取消生成没有完整版本化存储；Store现有“较长正文更新”行为保留。既有脏历史与native ID可能并存，未自动归一；原始时间、完整顺序、整段完整性和Markdown源码恢复不在本次承诺内。保存的是实际DOM观察正文，不生成缺失的原文。

停止于Module2，等待验收，不进入下一模块。

## 证据与记录说明

本轮实际使用 systematic-debugging 与 verification-before-completion：先记录真实SPA与各层差异，再以旧Reader运行同一回归得到3项失败，最后运行修改版与全套回归。最终运行Python29项通过、JS44项通过，git diff --check通过。根因报告先于生产代码修改生成。

交付目录中的module2-baseline-store.json为混合时点快照：A/B保留初始30/12行，C被后续只读检查覆盖成79行（40条非空Assistant）。初始C控制台记录为69行、35条非空Assistant，原始逐行哈希未保留；不把该文件C部分当作修复前快照。最终正确性证据使用module2-final-native-snapshots.json与module2-real-native-verification.json。

最终测试原始日志：module2-final-python.log、module2-final-js.log；旧Reader失败日志：module2-regression-red-baseline.log。真实新对话重启证据：capture-module2-fresh-before-restart.json、capture-module2-fresh-stopped.json、capture-module2-fresh-restarted.json。截图module2-fresh-real-chat.png为真实ChatGPT页面，不是原生Popup截图。

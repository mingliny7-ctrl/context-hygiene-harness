# Collector Popup 回归：根因与最小修复

修复基线2d666f9，2026-10-15，初始Git工作区干净。

修复前真实SQL/API：视频内容总结Conversation 6aa216a1-c604-83ec-b098-4426db9046f4有5条非空Assistant，API计数5，却返回order_unverified/null预览；测试Conversation有1条，返回single_verified_answer；旧开发Conversation有40条非空Assistant，包含5条native identity，API返回总数null、已确认5，Popup把数字整体隐藏成暂不可用。证据popup-regression-audit.json与popup-regression-before-api.json。

根因：saved_assistant_preview错误使用原始对话顺序口径，多条即拒绝；saved_assistant_count本来不依赖顺序，但旧fallback身份会导致总数null，Popup未突出已确认子集。Store的SQL WHERE只在新行/更长正文时写入，但没有记录真正写入事件；conversations.updated_at每次同步都更新，不能作为有效回复事件。Popup另有每1.5秒查询前先渲染缓存，反复重置预览/状态的问题。已有导航请求序号和响应conversation_id核验应保留。

最小方案：增加collector_save_state一张独立表，每个Conversation只存最新有效Assistant实际写入对应的key、16字预览、revision及时间。原文写入和状态更新共用同一事务；重复同步不增加revision。已有历史不补造事件。无事件但有旧有效回答显示历史兼容状态；无有效回复显示暂无。已确认原始ID计数正常显示，无法去重的旧fallback总数保持受限，Popup显示“至少N条（旧身份待确认）”而不是猜精确总数。不按正文相似性合并。

Reader/Bridge、canonical防护、Atlas、Monitor均不修改。原Store较长正文保留策略不变；等长/较短编辑仍不接受，未实际持久化就不产生事件。

## 迁移与回滚

真实数据库已在任何迁移前使用SQLite backup API生成一致性快照：data/backups/before-popup-events-20261015-153528.db，PRAGMA integrity_check=ok，备份含30条Conversation、673条Message；路径与SHA256见popup-regression-backup.json。在线备份包含已提交WAL内容，不直接复制活跃.db。

迁移由既有init_db执行CREATE TABLE IF NOT EXISTS collector_save_state，未修改原表或回填历史事件。旧Atlas只读查询不变。最新事件仅对实际提交写入生效；同一次批量事务中多条回答依次写入，最后实际写入的一条作为最近保存，不宣称是ChatGPT最后一条。

回滚优先保留全部采集原文：停止采集后端，切回2d666f9版本后，仅执行DROP TABLE IF EXISTS collector_save_state，然后使用旧版启动。DROP只移除新状态元数据，不删除conversations/messages。若需完全恢复备份，应先另备份当前库、停止所有连接，再用SQLite backup API把备份还原到目标库；这会丢失备份之后采集的数据，不能未经确认直接执行。已在独立测试数据库验证drop/re-init与旧原文保留。本轮未对真实库执行回滚。

## 修复前后口径

回复数始终不依赖source_order；排除非Assistant与空白正文，按(conversation_id,message_key)唯一记录统计，native UUID可证明唯一。旧fallback无法与native推断映射时不按正文合并：精确总数仍null，但UI显示已确认子集“至少N条”并解释旧身份限制。当前真实开发对话40条非空Assistant记录含5条native，不能宣称40条就是40个唯一回答。

预览从“唯一回答才显示、否则拒绝”改成“最新真正提交的新增或被接受的正文更新事件”；首次观察时间、同步请求时间、原对话顺序均不用于猜测。事件与原文事务同时提交，失败全部回滚。16个Unicode字符后加省略号，CSS强制单行，textContent纯文本不可点击。GET在同一个SQLite读快照读取计数输入与最新事件。已有历史没有事件时显示历史保存事件未记录，重复同步不会补造；首次真正新增/更新后自然转为saved_event。

Popup不再每1.5秒把数据库确认结果重置为缓存/等待状态；导航仍同步清空旧信息，序号与Conversation ID双重核验仍阻止旧响应回填，后端断开则清空数字/预览并显示未连接。

## 修改文件

- shared/conversation_store/database.py：只增加collector_save_state表，兼容迁移。
- shared/conversation_store/store.py：实际写入rowcount触发同事务事件；同快照查询；无有效原文的事件不显示。
- plugins/context_hygiene/backend/app/main.py、schemas.py：复用/sync与GET status，新增latest_save_revision，状态saved_event/history_untracked/empty。
- shared/chatgpt_bridge/popup.js、popup.css：确认数量及受限子集、16字单行、历史兼容状态、消除轮询清空。
- tests/test_collector_events.py、test_api.py、tests_js/popup.test.js：新增/更新/重复/失败/迁移/回滚/重启与导航回归。
- docs/collector-popup-regression.md：本记录。Reader、Worker、Atlas文件未修改，未触碰风险检测。

## 自动化验证与真实验证

实际使用systematic-debugging先审计SQL/API/源码并报告根因，随后新增事件测试在旧实现出现2项失败（order_unverified、single_verified_answer不符合新口径），修改后通过。verification-before-completion最终全量Python33项、JS47项通过，1条既有Starlette/httpx弃用警告，git diff --check通过。

|验收|状态与证据|
|---|---|
|A/B：3条有效回答、无source_order|PASS：真实Edge测试6ad07a99-6328-83ec-a2ed-831fdeaa13fc达到3条Assistant，接口计数3，预览第三条，revision2；独立数据库测试也覆盖|
|C：新增第4条|PASS：真实Edge发送ATLAS_POPUP_REGRESSION_004，数据库8条消息、4条Assistant，预览第四条前16字加省略号，revision3|
|D：重复同步|PASS：受控数据库连续3次完全相同回执；真实A返回后再采集计数仍4、revision仍3、预览不变|
|E：晚发现旧回答|PASS受控API/SQLite：新发现旧回答会成为最新保存事件；真实手动滚动尚未证明有额外旧消息入库，UNVERIFIED|
|F：A→B→A→C|PASS真实Reader身份/正文：四阶段原始消息UUID、正文SHA256与当前SQLite逐项匹配；Popup异步乱序与四阶段计数隔离由JS测试覆盖|
|G：重启恢复|PASS真实后端18012停止，8000不监听，再启动12260；A事件完整行与原文哈希315523454e4e1b21e14a63c6a710279f7a7de998071837c7ffb22f65ae0b0423不变，计数4，revision3|
|H：后端断开|PASS自动化断开反馈；真实后端停机已执行，但原生Popup停机瞬间显示未采样，UNVERIFIED原生显示|
|I：旧历史|PASS真实只读：视频总结5条native正常计数5，无事件不猜预览；开发对话40条原始非空记录、仅5条native可确认，UI显示至少5条；旧库迁移不回填事件/不改原文由独立测试覆盖|
|原生Popup|PASS用户手工确认：重载后回复“计数、预览和状态均正确”；不是工具直接读取的原生UI证据|
|Atlas|PASS现有详情API HTTP200，Atlas测试25项包含在JS47项内；Atlas代码/模型未改|

真实浏览器操作曾超时，随后按数据库/页面核对确认已发送，没有盲目重发。未把操作超时当作成功；测试截图popup-regression-four-answers.png是真实ChatGPT页面，不是Popup截图。浏览器管理页由用户手动重载，未绕过协议访问限制。

## 已知边界与证据

保留原Store“只接收更长正文”规则；等长或较短编辑不持久化，本轮没有扩大到编辑/分支版本化，也不会为这些未保存内容生成事件。原DOM采集完整性、Markdown源码恢复、全库历史身份归一均未解决；未删除历史原文。新表只保留每个Conversation的最近事件与累计revision，不是历史阅读或事件日志产品。

证据目录含popup-regression-audit.json、popup-regression-backup.json、popup-regression-real-three.json、popup-regression-real-four.json、popup-regression-real-repeat.json、popup-regression-real-navigation.json、popup-regression-before-restart.json、popup-regression-after-restart.json、popup-regression-stopped.json、popup-regression-scroll-status.json、popup-regression-python.log、popup-regression-js.log。

完成本次回归后停止，不进入下一模块。

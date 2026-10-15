# Module 4：消息先后顺序

基线f864d70，2026-10-15。没有接入模型、生成主题块或修改图谱视觉。

## 真实时间审计

在真实Edge测试Conversation 6ad07a99-6328-83ec-a2ed-831fdeaa13fc中读取8个User/Assistant消息单元及各自4层祖先属性。未发现逐消息创建时间。页面只有一个time，datetime=2026-10-15T07:03:10.871Z，父节点为role=separator的日期分隔栏，closest message=null。不能把这个分组时间赋给每条消息。证据module4-reader-time-audit.json；结论仅针对当前可访问DOM，不声称ChatGPT后台没有时间。

当前Reader采用DOM顺序，不读取隐藏应用状态或另建抓取接口。API的可选source_created_at表示调用方提供的真实Unix秒创建时间；只有明确原始来源才可填写，不从本机时钟、first_seen_at、updated_at或保存事件推导。原始时间分支通过受控样本验证，当前真实Reader没有该字段来源，不声称已经从ChatGPT取得逐条时间。

## 最小数据流

Reader仍按Conversation累积原文；额外把本次唯一活动DOM窗口中已识别消息key自然顺序发送为observedOrder。Worker只转发observed_order，不能把缓存Map的发现顺序当作真实顺序。API校验该列表无重复，且所有key都来自同一请求的messages。

Store与原文同事务保存独立conversation_order_evidence表。只记录原始时间、已观察key及相邻消息先后关系；重复关系去重，不记录滚动日志或观察时间。滚动前后重现同一稳定key，就可连接相对顺序。例：先观察u2→a2→u3→a3，后观察u1→a1→u2→a2，结果u1→a1→u2→a2→u3→a3。

读取时优先使用已明确提供的原始时间升序；相同时间靠DOM关系，不拿key或入库时间猜先后。没有时间的消息使用已证实DOM关系；只在剩余下一条唯一时确认位置。断开的窗口不强行连接，有矛盾/分叉则标记未知。实现仅有一个小的顺序证据模块，不增加任务队列或新采集系统。

## 只读契约与阅读

read_stored_conversation及Atlas现有详情API新增：sourceCreatedAt、sourceOrder（已采集记录中的全局序号）、orderGroup、relativeOrder、orderStatus。quality.ordering为source_time/dom_relative/partial/unresolved。只在全部已存储消息能唯一连成一个有序组时提供全局sourceOrder；partial仅保证同一个可信组内部的relativeOrder，不保证组间先后或整段完整性。冲突组orderStatus=conflict。

LLM后续应使用此带可靠性信息的详情契约，不使用旧get_messages的内部首次观察列表，也不把空正文、未知历史或组间排列当作完整可靠输入。get_messages保留兼容旧内部调用，本轮没有把它的观察时间当作对话时间。

Atlas仅调整既有原文阅读区的顺序标注/说明，没有改变图谱布局、动效或业务边界。未知历史保留全部原文，标注历史顺序未确认；可重现其稳定ID时补充顺序证据，不自动合并旧fallback记录。

## 数据库兼容和回滚

迁移前使用SQLite backup API备份真实库到data/backups/before-popup-events-20261015-202555.db，integrity_check=ok，含30 Conversation、695 Message，SHA256=c25d6de6d379a8d514fd90fc8e81ae1e74672ce412bc7fd2b7a600fa8b061ef7。实际文件名沿用既有备份脚本；本轮记录为module4-backup.json。

既有Collector init_db只增加conversation_order_evidence表，不改原messages表，不回填时间或身份。Atlas只读端支持旧库缺少新表，不执行迁移。回滚：先停止服务、切回f864d70，再仅DROP TABLE IF EXISTS conversation_order_evidence即可移除本轮元数据，保留原文和collector_save_state。不得直接恢复整库备份覆盖之后的新采集数据。独立测试验证旧历史无证据状态，实际库不执行破坏性回滚。

## 修改范围

- Reader/Worker：仅增加当前窗口顺序字段与元数据变化触发；保持身份、完成态、缓存和导航隔离。
- Store/database.py/message_order.py：独立证据表、同事务合并和带可靠性排序读取。
- Collector schemas.py/main.py：可选真实时间、DOM key序列验证和透传。
- Atlas backend/main.py、既有frontend/messages.mjs/app.mjs：只读顺序字段和原文状态说明。
- tests/test_message_order.py、test_atlas_api.py、tests_js/reader-stability.test.js、worker.test.js：先失败再修复、重叠、断开、矛盾、时间优先、重启与Reader/Worker转发测试。

本模块完成后停止，不提前接入LLM。

## 最终验证

PASS：旧实现运行新增顺序测试3项失败，修复后通过。最终Python37项、JS49项通过，1条既有Starlette/httpx弃用警告；git diff --check通过。覆盖时间优先、反向发现历史、重叠连接、断开窗口、冲突顺序、重复同步、跨Conversation、重启、旧库只读、顺序元数据不产生新保存事件，以及Reader/Worker的窗口顺序转发。

PASS真实Edge→Reader→Worker→/sync→SQLite→Atlas API：用户重载扩展后，刷新既有受控对话。8条消息按User/Assistant四轮自然顺序返回sourceOrder=0..7，quality.ordering=dom_relative，逐条key、role、正文SHA256与真实DOM一致；sourceCreatedAt全部null，没有虚构时间。顺序证据采集之前，同一记录明确为unresolved；采集之后才变为已确定。证据module4-before-reader-reload.json、module4-real-dom-order.json、module4-real-verified.json。

PASS原始数据：备份中695条Message在当前库中的role/content逐条不变；受控对话的collector_save_state完整行也与备份一致。未清理fallback，未覆盖原文。

PASS真实服务重启：完整停止Collector和Atlas（两个端口均不监听），再启动Collector39324与Atlas32444；相同8条key、role、sourceOrder、正文校验及保存事件保持一致。证据module4-stopped.json、module4-restarted.json。

UNVERIFIED：本轮没有让用户实际滚动产生多个历史窗口；重叠滚动拼接来自受控Reader/HTTP/SQLite测试，不能冒充真实滚动验收。真实逐消息创建时间不可用，所以时间优先分支只有受控输入验证，未声称已取得ChatGPT时间。

BLOCKED：Atlas内置浏览器原文阅读UI实测。刷新已有错误页标签时，浏览器安全策略拒绝动作（协议/页面权限检查未通过，只允许http/https）；没有用其他浏览器表面或低层命令绕过。Atlas本轮实际验证为只读HTTP API与既有自动化回归，页面显示说明的实机验收仍待用户检查。服务可访问http://127.0.0.1:4173/。

## 尚存边界

DOM顺序仅代表已观测的当前页面分支，不能恢复从未显示过的旧消息。分支、重生成或平台DOM改变可能产生相互矛盾的顺序证据，此时停在conflict/unresolved，不猜测。旧fallback与native不能靠正文合并，所以含旧身份的完整对话可能长期为partial。当前顺序不代表历史完整性，不根据顺序自动开启任何LLM任务。

日志：module4-python-tests.log、module4-js-tests.log；备份：module4-backup.json；消息时间检查：module4-reader-time-audit.json。结束后保持两个现有服务运行，等待验收。

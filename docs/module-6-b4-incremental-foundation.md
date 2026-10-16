# Module 6 / B4：手动增量索引持久化基础

基线 `08fa0d5`，分支 `feat/conversation-atlas-prototype`，开始时工作区干净。已阅读仓库外 B1/B2 报告；相关源码、docs 和现有审计输出中未找到 B3 完成记录，不宣称 B3 已验收。

真实来源资格复查：`6ad167d6-6280-83ec-ad53-dfb5df448a9b` 的 4 条有效消息身份与顺序可用；`6aa216a1-c604-83ec-b098-4426db9046f4` 含“显示更多”，B4 保守阻止其进入新 Segment 分析。这不阻塞独立测试库的基础接口验证。没有改采集链或补造真实 Segment。

## 代码范围与复用

- `plugins/conversation_atlas/backend/incremental_index.py`：差异查询、有界 context/pending 计划、手动批次准备、原子提交、恢复与幂等。
- `tests/test_incremental_index.py`：24 项确定性本地用例，禁止调用 DeepSeekProvider。
- `tests/test_message_order.py`：修复一个旧测试跨秒不稳定问题；重复同步会合法更新 Conversation.updated_at，应使用最后一次同步的快照验证重启。消息与顺序不变仍有独立断言。
- 本文：后续 B5/B6 契约与验收证据。

复用现有 `read_stored_conversation` 和 Module 4 顺序结果、`cache_path` 的派生库配置、Module 5 的 `SemanticAnalysis` / `validate_references`。没有新模型客户端、第三个服务或自动调度器。Atlas main.py、Reader、Store、Collector、Native Host、前端和 DeepSeek Client 均未修改。

## 最小表结构

沿用 `data/atlas_analysis.db`，保留 `conversation_analysis`。新增：

| 表 | 关键字段及用途 |
|---|---|
| atlas_segments | CID + Segment ID 主键；revision、start_key/end_key、结构化 analysis_json、theme_state、open/stable、schema/algorithm/prompt/model/analyzed_at |
| atlas_indexed_messages | CID + Message key 主键；role、正文 SHA256、可信 position、Segment 外键；每条消息唯一归属，覆盖清单不存正文 |
| atlas_index_batches | 确定性 batch_id、CID、无原文 manifest、prepared/completed/failed/interrupted、时间、失败码、结果指纹和回执 |

每个 Conversation 同时只能有一个 prepared 批次，SQLite 部分唯一索引强制约束。Segment 更新、覆盖插入和 completed 回执在一个 `BEGIN IMMEDIATE` 事务中完成；不存在先标完成后存 Segment 的窗口。

`position` 是已有可信消息序列的索引，不是写入时间；仅支持首次和尾部追加写入。中间插入会阻止提交并要求复核，不通过改位置假装修复历史。未构建通用消息版本树；Segment 当前结构保存最新摘要及 revision，不保存完整摘要版本历史。

## 差异与资格规则

`inspect(CID)` 是纯读取，不创建库、不迁移、不准备任务、不调用模型：

- 同 CID/key/role/正文哈希相同 → unchanged。
- 未覆盖且在已覆盖末尾之后 → appended（首次未索引时全部为首次范围）。
- 未覆盖且位于已覆盖消息之前/中间 → historical，要求复核。
- 同 key 内容变化 → changed；原覆盖消息消失 → missing；只标需要复核，不清理原索引。
- 已覆盖消息的相对顺序变化、索引版本不兼容 → review_required。
- canonical ID 不可靠、原生 Message key 与 role 不匹配、顺序非完整可信、正文含折叠迹象 → blocked。

“显示更多”检查是保守启发式，可能误伤讨论该字样的正常内容，不是完整正文的形式证明。历史完整性仍未知。空 User/Assistant 不分析；不把 System/Tool 作为分析材料。现有采集链不保存等长/缩短编辑的问题未被本模块修复，B4 只检测 SQLite 中实际变化。

`read_segments(CID)` 始终能返回保存结果，同时返回当前 source_status/source_reason；上层不得把 review_required/blocked 的旧结果冒充最新。B4 未改现有 HTTP 路由，读取新结构目前是内部 Python 接口，前端联通留待 B6。

## context / pending 契约

`plan(CID, max_input_bytes=24000, max_context_bytes=4000)` 不执行任务。

- context.segment：尾段持久化摘要、主题状态、ID/revision、边界。
- context.messages：预算内最近的已分析尾段原文，按真实相对顺序；不强制固定轮数。
- pending：有界的尚未成功覆盖的尾部原始消息，保留 key/role/content。
- manifest：两类消息各自的 key/role/hash、尾段参考状态、索引基线指纹、版本、预算；不保存 pending/context 原文副本。
- remaining_count：本计划后仍未选择的新增消息数。

历史原文最多 max_context_bytes，整个 JSON 输入加 2048 字节 Prompt/Schema 预留不得超过 max_input_bytes。UTF-8 字节是保守准入上界，不是实际 API Token 统计。B5 必须检查真实 Prompt/Schema 开销是否仍在预留内，并记录 API usage。单条正文超窗返回 MESSAGE_TOO_LARGE，摘要参考自身超预算返回 CONTEXT_TOO_LARGE；不截正文、不回退到全历史。没有新增时不构建历史上下文，直接 no_changes。

一次计划可以覆盖部分新增；多批由后续手动任务执行器按预算循环。当前是消息级窗口，尚不保证窗口恰好落在完整 Turn 结束处；B5 必须通过有界上下文、pending 状态或轻量组窗处理跨窗问答，不将窗口边界当主题边界。

## 手动任务与提交接口

以下都是本地自定义 Python 接口，尚未暴露 HTTP 执行入口：

1. `initialize()`：显式安装加表迁移；读取 Atlas 不调用它。
2. `inspect()` / `plan()`：查询，不触发模型。
3. `prepare_batch(plan, manual=True)`：显式手动意图才能准备任务；返回 batch_id、created、status。没有新增返回 no_changes。
4. `commit_batch(batch_id, updates, model=..., prompt_version=...)`：接受 B5 将来完成校验的结构化输出；B4 测试只传本地确定性数据。
5. `batch()` / `interrupt()`：读取进度、显式记录中断或失败；普通读取与进程启动不重试。

SegmentWrite = operation(create/extend)、稳定 segment_id、message_ids、SemanticAnalysis、theme_state。create 可在一批产生多个段；extend 仅能延续当前 open 尾段，并保留 ID、累加旧覆盖、增加 revision。每批新增归属必须严格按序、恰好覆盖 pending，不能重复纳入 context 或别的 Conversation。新段引用仅限本段 pending；延续段的新引用限当前提供材料或此前结果中已有的引用，不允许猜引用未提供的历史回答。

提交校验范围、角色、引用、索引基线及最新原文指纹。不同提交内容复用同 batch_id 返回 IDEMPOTENCY_CONFLICT；同一已完成结果重复提交返回原回执。并发准备同范围只有一个 created=True，其他调用必须复用任务，不启动第二次执行。

prepare/commit 之间允许无关尾部继续增加，但已准备的范围必须仍是原来的可信前缀。原文与派生库是两个 SQLite 文件，没有跨库原子锁；提交前复读 + 后续读取再次检测变化，不能声称消除了全部跨库竞态。

## 恢复与未来执行约束

成功批次的覆盖是恢复点，进程重启后仍跳过这些消息。failed/interrupted 未覆盖范围再次手动准备可重试。遗留 prepared 表示已存在工作，不代表重启后可以自动执行；B5/B6 要确认旧执行器已退出后显式中断并在本次手动意图下恢复，不能直接强抢活跃任务。

B4 不执行网络请求，未实现模型请求计数、实际 Token 日志、超时租约或后台执行循环。B5 须增加执行记录与预算：一次手动操作限定请求数/输入/输出/运行时间，重试也消耗预算。远端已执行而响应未保存时状态未知，不承诺恰好一次扣费。

B6 的建议 HTTP 契约（仅定义，未实现）：

- GET Conversation 增量状态/Segment/任务：只读，可自动轮询。
- POST Conversation 手动分析：由 Atlas 用户按钮触发；后端重新生成计划，不信任客户端提供的正文、指纹或覆盖范围；没有新增直接返回，活跃任务返回既有任务，其余返回 202。
- 任务执行属于 Atlas 进程内部；只有该次手动授权可以运行后续有界批次，不在启动/打开/切换/空闲时调用模型。

旧 Module 5 Conversation 摘要继续复用，但它没有 Segment 边界或逐消息成功覆盖，不能冒充已完成分块。首次 Segment 建立仍需 B5 明确的手动任务；本模块不会因旧整段指纹变化调用 Module 5 全量重算。

## 迁移、回滚与实际验证

2026-10-16 已执行真实派生库兼容迁移。迁移前 SQLite backup：

`D:/study/desktop-pet-harness/data/atlas_analysis.b4-backup-599aee9fd66f49de91cd8cfdcb188b41.db`

迁移后：原 2 条 conversation_analysis 记录逐字段一致；Module 5 v2 缓存实际仍命中；新增三表均 0 条，没有将确定性测试结果写入真实库。原文库 schema 和全部记录的只读快照指纹在迁移前后一致；派生库 quick_check=ok。原始库未迁移、未清理。

回滚优先恢复旧代码，新表可保留，旧代码会忽略它们；不要在线替换数据库。确需文件恢复时先停止所有 Atlas 写入、保留现库及旁路文件，再以 SQLite backup 恢复上述备份到派生库；这会丢弃备份后的新派生结果，需明确确认。不得恢复或覆盖 conversations.db。本轮未执行回滚或删除表。

验证命令：

```powershell
& .\plugins\context_hygiene\.venv\Scripts\python.exe -m pytest tests/test_incremental_index.py tests/test_semantic_analysis.py tests/test_message_order.py tests/test_atlas_api.py -q
```

结果：65 passed。B4 24 项覆盖：稳定差异、首次/追加、原 ID 延续、多段单批、事务失败全回滚、幂等、真实新子进程恢复、事务中途进程退出回滚、分批断点、历史补录、正文变化、身份/顺序/折叠阻止、引用限制、并发单准备者、来源变化拒绝、预算和迁移备份兼容。长样本测试为本地确定性 100 条已覆盖 + 12 条新增，不能当成真实 100 轮 DeepSeek 验收。真实模型调用为 0。现有 Starlette/httpx 弃用警告仍在，不影响通过。

## B5 / B6 尚未完成

- B5：真正 DeepSeek 语义分块 Prompt、尾段摘要补丁与事实忠实度、真实样本人工验收、完整 Turn/超长单条策略、实际调用/Token/预算与执行租约。复用现有 Client，不创建第二套模型服务。
- B6：Atlas 按钮、手动任务 API、Atlas 内部后台执行及只读轮询联通。现有视觉不变。
- 历史补录与编辑的复杂局部重建不在 B4，当前明确待复核，不自动全量分析。

完成 B4 后停止；没有调度或真实语义分块已完成的声明。

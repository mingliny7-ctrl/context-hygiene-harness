# Module 6 B5+B6：手动增量语义索引交付记录

基线 `f5b7d04`；实施及真实调用：2026-10-16；断点恢复、最终回归：2026-10-17。

## 功能与修改范围

| 文件 | 功能 |
| --- | --- |
| `backend/incremental_index.py` | 复用 B4 三张表与原子提交；增加完整轮次边界、点击范围快照、有界且明确标记的参考原文片段 |
| `backend/indexer.py` | Atlas 内部手动任务、复用 DeepSeek Client、结构及来源验证、预算、进程锁、请求账本与失败恢复 |
| `backend/segment_api.py` | Segment 专属关键回答、覆盖范围、完整原文及可信相邻 User 关联 |
| `backend/main.py` | 图谱读取持久化主题，提供状态、手动分析和精确原文接口；保留 Module 5 缓存接口 |
| `frontend/index-controls.mjs` | 当前 Conversation 的分析按钮、状态轮询、重复点击及过期响应保护 |
| `frontend/app.mjs`、`index.html`、`styles.css` | 最小入口接线、真实主题展示及键控节点更新，保留粒子和布局实现 |
| `frontend/messages.mjs` | 宽阅读区显示真实 User/Assistant 完整存储正文；不由模型重写原文 |
| `tests/test_semantic_indexer.py`、`frontend/tests/index-controls.test.mjs` | 任务、范围、引用、预算、失败恢复、只读及 UI 状态回归 |

以上路径的前缀分别为 `plugins/conversation_atlas/`（tests 根目录例外）。没有修改 Collector、Reader、Store、Native Host、Module 5 Client/缓存和粒子布局源码。

## 数据与执行契约

- 复用 `atlas_segments`、`atlas_indexed_messages`、`atlas_index_batches`。Segment 更新与消息覆盖仍由 B4 同一事务提交。
- 仅新增 `atlas_index_runs`（一次手动任务的目标、预算、状态）及 `atlas_index_calls`（请求次数、来源 ID、模型、Token、请求标识、失败代码）。它们不重复存储 Segment、覆盖或聊天正文。
- 原文：`data/conversations.db`；派生索引：`data/atlas_analysis.db`。Indexer 只读原文库。
- 运行表首次创建前已通过 SQLite backup 保存 `data/atlas_analysis.b5-backup-7b548a70b7e446229cd6d8e74dbbdfd6.db`；迁移只新增表，不变更 B4/Module 5 表。旧代码可忽略新增表。需要完整回滚时先停止 Atlas、备份当前派生库，再恢复此备份；这会撤回 B5 后的派生结果，不能用原文库替代派生库。
- GET 图谱/状态/原文、服务启动、页面刷新和 Collector 同步均不触发模型。只有带 `x-atlas-action: manual-analysis` 的手动 POST 创建任务；校验同源 Origin。UI 只处理当前选中对话。
- 同身份、同正文指纹、同可信覆盖跳过；历史插入、编辑、顺序或身份问题进入待复核，不悄悄全量重算。
- `context` 为尾段摘要、主题状态和有界真实问答；`pending` 为本次完整未索引轮次。参考不足时允许明确的 `contextExcerpt`/字符范围，pending 不截断。输出只能覆盖 pending，恰好一次、顺序一致，边界落在完整轮次之间。
- 模型决定延续/新建。延续只能指向开放尾段；旧 ID、结论和引用保留，新增关键回答必须属于该段 pending。Python 校验角色、引用、原文指纹及事务前来源快照。
- 点击时冻结目标末端；分析中后来采集的数据留待下次点击。操作系统锁防止重复执行。每批成功即形成恢复点；失败或退出不撤销之前已提交批次。重启不会自动重试付费调用。
- 默认每次点击最多 2 请求（含至多一次格式修复）、总输入 64,000 / 输出 8,192 Token 预算、每请求输入上限 32,000 / 输出 4,096、参考上下文最多 4,000 UTF-8 字节、执行预算 360 秒。输入使用 UTF-8 字节保守上界；不能装入的完整轮次暂停处理。网络失败保留保守预算，不循环重试。
- 模型配置继续使用 Module 5 私有配置。切换模型不使兼容覆盖失效。账本不保存密钥、完整聊天正文或模型错误原文。

## 真实付费与浏览器验证

用户批准最多 3 次，本轮实际 **2 次**，未使用第三次。

样本 Conversation：`6ad167d6-6280-83ec-ad53-dfb5df448a9b`，原生 Message ID、可信 DOM 相对顺序。原始 2 轮/4 条；通过真实 ChatGPT 页面新增 2 轮，既有 Collector 自动保存后共 4 轮/8 条。没有用 SQL 构造正式对话或 Segment。

| 请求 | 实际模型 | 输入 / 输出 Token | 结果 |
| --- | --- | --- | --- |
| `86e08de7-4ff1-4cdf-acd7-2bcec88f3ad6` | `deepseek-v4-pro` | 5,266 / 2,042 | 真实 Edge 手动按钮提交原 4 条，生成 2 个主题 |
| `36743e3a-09d8-4ab8-b881-66c98824ab7d` | `deepseek-v4-pro` | 2,650 / 1,508 | 手动提交新增 4 条和有界参考，延续 1 段、新建 1 段 |

合计输入 **7,916**、输出 **3,550**、总 **11,466** Token；均 committed。第二次计划参考上下文序列化大小 3,999 字节，不包含全部历史。两次实际账本已记录 context/pending ID 与 usage；之后增加的片段字符范围日志字段仅适用于后续请求，未伪造补写旧调用日志。

| 持久化 Segment | 标题 | 最终版本 |
| --- | --- | --- |
| `seg:f34e111675cbae04a3b79031` | Codex双账号共享记忆与断点接力方案 | revision 1，原段保持不变 |
| `seg:59b36cd6b51ea0d4509c5046` | 图谱项目类似实现与借鉴分析 | revision 2，同主题新增问答延续原 ID |
| `seg:4f9ee8062f11401c2c6e8fc8` | Python文件关闭机制：try/finally与with | revision 1，新主题 |

真实验证记录：

1. 首次、增量两次均从 Edge Atlas 手动按钮触发；成功后自动出现/更新主题，无需刷新。点击主题专属关键回答，显示正确 User 和 Assistant 完整存储正文。
2. 原 4 条消息指纹未变；8 条覆盖唯一。无新增时手动 API 返回 `no_changes` / requests 0，账本仍为 2。
3. 服务停止并重启后三个主题、稳定 ID 和版本恢复；页面重开仅 GET，账本仍为 2。2026-10-17 再次恢复服务并实际打开 Edge，显示已索引 8 / 待分析 0。
4. Collector 停止时 Atlas 图谱、主题与原文仍可读取。最终已恢复 Collector 18000 与 Atlas 4173，二者独立健康检查通过。
5. Module 5 旧缓存实际命中；两条旧 Conversation 分析缓存保持存在；派生库 quick_check 正常。原文库增加的四条仅来自真实 Reader 采集。

上述验证证明引用、持久化和增量路径，不代表模型结论已由人工或外部资料确认。语义划分质量待用户验收。

## 自动化证据

最终定向运行：**103 Python tests passed；62 JavaScript tests passed**；`node --check .../app.mjs` 和 `git diff --check` 通过。

Python：semantic_indexer、incremental_index、semantic_analysis、message_order、atlas_api、native_host、collector_control。JavaScript：Atlas frontend tests、native-services、reader、worker、popup。

覆盖：只读无调用、重复处理零调用、重启复用、同段延续、新主题、精确原文及跨段引用拒绝、错误输出/有限修复、跨进程锁、预算与请求范围、批次失败保留前批、后到消息不扫入、完整轮次、有界参考片段、变化 User 不冒充关联提问、请求期间原文变化停止且不自动重算。异常模型为确定性测试，真实模型证据为上表两次请求。

现有 Starlette/httpx 弃用警告 1 条，不影响测试结果。

## 人工验收入口

1. 使用现有 Edge 插件「打开图谱」或访问 `http://127.0.0.1:4173/`。搜索 `Codex双账号`，选择 Conversation 结果。
2. 核对三个主题、已索引 8 / 待分析 0；点击主题，再点击「关键回答」核对原文。此时不会新增模型请求。
3. 在同一 ChatGPT Conversation 继续真实讨论，等待 Collector 确认保存。Atlas 自动显示 pending；只有点击「分析新增内容」才产生新的付费调用。请人工判断同主题延续及新主题边界。
4. 关闭重开图谱，已有主题保留；没有新增时按钮禁用并提示最新状态。可在既有插件关闭 Collector 后继续浏览已有索引。

本机证据目录（不提交聊天材料到 Git）：
`C:\Users\Administrator\Documents\Codex\2026-10-14\files-pasted-by-the-user-conversation\outputs\b5-b6`

其中 `validation.json` 为真实调用/版本证据，`final-segments.png` 为重启后图谱，`final-answer.png` 为准确 User/Assistant 阅读区。

## 已知限制与未验证事项

- 本轮真实样本较短；没有宣称完成 100/500 轮长历史、长对话滚动拼接及所有历史来源的真实验收。不可信历史明确阻止自动索引。
- ChatGPT 原始标题未由当前 Store 保存，Conversation 展示名取首个主题的 AI 标题，并标识来源；无原始发送时间时显示未记录，不用采集或分析时间替代。
- User 关联为已确认相邻顺序，不声称验证 ChatGPT 分支父子关系。无法确认时不补造提问。
- Reader 保存的正文可能不保留原网页全部 Markdown 格式；阅读区忠实显示存储正文、支持已有代码围栏，不通过模型补格式或补全文。
- 旧 Collector 对短文本编辑等采集边界未在本轮改动；已发生正文变化的索引转入复核。没有实现历史编辑重建。
- 现有分析 Schema 限制每段最多 5 个关键回答、10 条结论；累积超过约束时明确失败，不静默丢弃旧结论。
- 当前布局在会话数量较多时仍需沿已有工作区滚动，未进行视觉重设计。
- 本轮未重新人工点击原生扩展 Popup 两个按钮；其代码未改，相关自动回归通过。实际服务恢复使用同一后台 Launcher。
- 不新增自动调度、收藏、Embedding 或第三服务；本模块提交后停止，等待用户功能与语义质量验收。

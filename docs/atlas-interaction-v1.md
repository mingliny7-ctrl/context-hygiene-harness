# 图谱层级与交互优化 V1

基线：`aac206d`。本轮保留 B4/B5+B6 持久化、手动分析、粒子核心和贝塞尔连线；没有修改 Collector、Reader、Native Host 或原始聊天记录。

## 使用

现有插件「打开图谱」或 `http://127.0.0.1:4173/`。

首页只展示最近六个有可证实保存事件的 Conversation；点击会话平滑聚焦到统一左中锚点，右侧展示该会话的主题。返回 Atlas 恢复首页。其他会话仍可通过搜索、最近对话访问。

现有真实样本可搜索「双账号协作续接」，包含「双账号协作续接」「图谱方案借鉴」「Python 资源管理」三个主题。点击主题查看分段摘要、讨论要点和关键回答，点击「阅读回答」打开对应 User 和完整 Assistant 原文。

聚焦会话后，图谱下方「浏览对话原文」保留全部原始消息阅读入口。

## 活动排序的真实口径

读取既有 `collector_save_state.saved_at`，仅在有效 Assistant 真正新增/正文变长并成功提交时更新。重复同步、单纯 `conversations.updated_at` 变化不算活动；旧库无此表或无事件时不伪造最近活动。

**已知限制：当前 Collector 只记录 Assistant 保存事件，纯 User 新增尚无同等事件。** 本轮不改采集链，因此首页排序明确使用已确认 Assistant 保存事件；没有事件的历史仍可搜索，不用观察/同步时间补位。后续若要覆盖纯 User 保存，需要单独确认最小采集事件扩展。

## 布局和阅读

- 首页最多六条核心连接，不默认展开 Segment；没有跨 Conversation 关系推断。
- 聚焦布局只保留选中 Conversation 及所属 Segment，不为全部历史生成纵向大列。节点 ID 和 DOM 复用，720ms 位置/曲线过渡；统一响应式坐标与原粒子插值，不按入口方向写多套动画。
- 常规桌面下短主题集位于可视工作区；大量主题沿纵向工作区滚动。小屏保留滚动和详情浮层，不宣称能在一屏塞下任意数量节点。
- 摘要只做段落排版和已有关键词/Markdown 重点加粗，不删改原始回答。详情隐藏内部 ID、覆盖范围、数据库字段；后端引用仍保留。原文阅读保留真实正文和代码围栏，不生成补全文本。

## 标题与兼容子内容块

新分块 Prompt 要求主题名优先 4–10 汉字、子块名优先 4–8 汉字，必要技术名保留，不机械截断。

三个既有标题按用户本轮给出的示例进行人工语义命名，不调用模型。仅修改派生 `analysis_json.title`；已逐行比对备份：Segment ID、revision、边界、主题状态、模型信息、引用和全部覆盖行未变。备份：

`data/atlas_analysis.visual-v1-backup-dcf8a19cd234447581953aee07d18396.db`

新增 `segment_schema.py`，在原 `analysis_json` 内兼容可选 `subtopics`，不新增表、不改变 Module 5 Conversation Schema。旧 JSON 默认空列表，旧幂等结果摘要继续兼容。

每个子块：`block_id`、`title`、`summary`、有序 `message_ids`、`key_assistant_answers`。服务端产生稳定 ID。默认不生成子块；确有多个独立子议题才产生至少两块。同一真实回答可能涉及多个子议题，允许引用重叠，但不重复计算正式 Segment 覆盖。

模型只能为当前 pending 生成新子块引用；Python 验证本段来源、可信顺序、Assistant 角色和子块归属。延续 Segment 保留既有子块；新子块与覆盖通过 B4 同一事务保存。错误子块不能污染索引。子块导航有返回主题入口；切换子块后过期原文响应不会打开旧内容。

**当前三个真实旧 Segment 没有子块数据，继续直接展示主题详情。** 本轮没有为展示效果填充假子块，也没有重新分析旧历史。子块持久化/引用路径使用隔离确定性测试验证；真实 DeepSeek 的子块质量及实际复杂主题交互尚待新的授权样本验证。点击旧主题或子块入口不会调用模型。

## 修改文件

- 后端：`main.py`（只读活动事件）、`segment_schema.py`（兼容子块结构和校验）、`indexer.py`（语义命名/子块 Prompt、引用和 ID）、`incremental_index.py`（复用事务、兼容旧幂等摘要）、`segment_api.py`（子块数据及精确回答读取）。
- 前端：`layout.mjs`、`app.mjs`、`messages.mjs`、`styles.css`；保留粒子实现、手动分析控制器和 Collector 代码。
- 测试：`frontend/tests/layout.test.mjs`、`tests/test_semantic_indexer.py`。

文件均位于 `plugins/conversation_atlas/`，根目录 tests 例外。

## 验证记录

- 定向回归：105 Python、59 JavaScript 测试通过（1 条现有 Starlette/httpx 弃用警告）。
- 新增覆盖：最多六个真实保存事件排序；同步时间不干扰；各方向统一锚点；响应式边界和长列表无碰撞；子块稳定 ID 与原文关联；跨子块错误回答拒绝；错误子块提交回滚，消息仍为 pending。
- Edge 真实页面：六会话首页、左/右/上/下会话点击聚焦、返回首页、旧主题展开、简洁详情和准确原文读取。动画视觉舒适度仍由用户实际观察验收。
- 1000px 桌面视口下，选中会话和三个主题的实际边界均在可视工作区内；测试后已恢复用户原视口。
- 真实库：派生库 quick_check 正常；原有三段除标题外完全一致、覆盖记录一致；调用账本保持原来的 2 次，本轮新增模型请求 **0**。
- 没有本轮真实 DeepSeek 子块生成或长对话全量质量验收；没有重新人工测试原生 Popup 按钮，相关代码未变且自动回归通过。

本轮提交后停止，等待视觉、聚焦动效及阅读体验反馈。

本机截图和四方向坐标证据：`C:\Users\Administrator\Documents\Codex\2026-10-14\files-pasted-by-the-user-conversation\outputs\atlas-interaction-v1`（home.png、details.png、original.png、directions.json）。

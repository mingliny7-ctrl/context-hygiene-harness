# Collector 已保存回答预览

基线51463b8，2026-10-15。本轮只增加采集状态反馈，不修改Reader、Bridge、Atlas、原文或SQLite schema。

## 顺序审计与边界

messages只有conversation_id、message_key、role、content、first_seen_at、updated_at。get_messages明确返回first-observed order；Reader累计Map顺序也只是发现顺序。UUID不能排序，向上滚动会晚发现旧回答。因此本轮不把任何入库时间或数组末项当作真实最新回答。

数据库没有非空Assistant：empty，显示“暂无已保存的模型回答”。只有一条原始ID可靠的非空Assistant，且没有非空旧身份Assistant：single_verified_answer，这条唯一候选无需推断顺序，显示正文开头40个Unicode字符，超长追加省略号。多条或旧身份未确认：order_unverified，预览null，显示“对话顺序未确认，暂无法判断最近回答”。这意味着多回答Conversation暂不提供具体最近预览，符合不猜测要求。

正文仅从原Store读取。当前Reader已经要求native UUID、complete和非空才提交；本轮不改变采集有效性规则，也不尝试修补历史流式/空记录。旧身份非空记录不会被冒充有效最新回答。无需新采集协议或顺序迁移，避免为Popup扩大采集改动。

## 修改与契约

- shared/conversation_store/store.py：纯函数saved_assistant_preview，仅读传入的已保存记录。
- backend/app/main.py、schemas.py：/sync回执和GET status增加latest_assistant_preview、latest_assistant_status，本地自定义字段。原API字段保持兼容。
- popup.html、popup.css、popup.js：纯文本不可点击的预览，删除旧handoff元素/样式；无箭头、按钮、历史入口、Atlas跳转、字符统计。
- tests/test_api.py、tests_js/popup.test.js：顺序拒猜、截断、持久化、空回答、导航与异步串号防护。

Popup从GET当前正式Conversation状态确认预览，不直接展示DOM或浏览器缓存的预览。导航事件立即清空名称、计数、预览和状态；请求序号与conversation_id双重核验阻止迟到响应。存储变化只触发重新确认数据库。请求失败显示“无法确认已保存回答”，不继续展示旧预览。旧后端缺少新字段时也不猜测。

## 验证

PASS：新增API测试先出现缺字段失败，再修复；完整Python30项、JS46项通过，保留1条既有httpx弃用警告。原SPA隔离、流式完成态、持续mutation调度、累积采集回归通过。新增测试验证旧消息晚入库时预览null；异步B响应晚于切至C时只能保留C；切换事件同步清空；空回答、错误身份、临时ID拒绝和纯文本无链接。

PASS真实只读核验：现有SQLite D:\study\desktop-pet-harness\data\conversations.db共29 Conversation、663 Message；重启采集后端8940→27036后，新测试6ad07a99-6328-83ec-a2ed-831fdeaa13fc返回预览“稳定采集验证完成。”、2条消息、1条有效Assistant。多回答6ab523fd-3fc0-83ec-a28b-ee7549dc7e47返回order_unverified及null，未用晚入库旧消息冒充最新。新测试原文哈希重启前后均为865295124eb81606d7abe3316b317543149259c00921727501556b35a274fe2a；Atlas原文HTTP200。

UNVERIFIED：本次新增Popup尚未经用户重载扩展后的原生界面检查；不能沿用上一版用户确认声称本版也完成实机Popup验收。真实手动滚动稳定性仍以Module2记录为准，本轮只验证其自动化回归，未代用户滚动或宣称新增完整历史采集证据。

交付证据：preview-python-tests.log、preview-js-tests.log、preview-real-api.json、capture-preview-before-restart.json、capture-preview-after-restart.json。

现有采集服务8000已运行新版；查看新版Popup需在Edge重载原扩展一次后重新打开Popup，Reader文件未变。后续仍优先采集稳定性，不启动Atlas新功能或顺序采集扩展。

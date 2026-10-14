# Module 1 — Conversation 身份归一

基线：`78ba072a`。范围仅为新聊天的 Conversation identity；不迁移历史、不改 Message identity、Monitor 规则或 Atlas UI。

## 根因与策略

临时 ID 由 ChatGPT 在新聊天尚未取得服务端 ID 时放入页面 URL，并非本项目生成。上一轮真实日志显示先发送 `/c/local-chatgpt%3A…`，再发送 `/c/<正式 ID>`。

Reader 原本只提取 `/c/` 后的任意字符串；Worker 原样提交；Store 以 conversation_id 为主键 upsert，因此两者各建一条记录。Worker 只有 tab→当前 ID 映射，Reader 只有按 ID 的内存缓存；没有可验证的 alias 关联。一个 tab 可以在 SPA 内打开多个聊天，tab ID 不能证明是同一 Conversation。

采用 **方案 A：正式 ID 出现后才持久化**。

- Reader 解码 ID 后识别 `local-chatgpt` 前缀（包括 `%3A`），临时阶段不发送、不建立可跨路由转移的草稿缓存；正式 ID 出现后继续由原有 DOM mutation、路由轮询读取正文。
- `/sync` 对临时 ID 返回409，防止仍在运行的旧版扩展继续创建临时历史。
- Shared Store 在打开数据库连接前拒绝临时 ID，保护直接调用者。
- 正式 ID 保持原字符串和既有 upsert 行为；没有引入 UUID 格式限制、正文匹配、alias 表、合并或删除。

修改前：临时 URL → Reader → Worker → `/sync` → 临时行；正式 URL → 同链 → 另一行。

修改后：临时 URL → 等待；正式 URL → 原 Reader/Worker → `/sync` → canonical 行。正式 Conversation 重复同步仍使用相同主键。

canonical ID 是持久化历史所使用的正式对话身份。正文相同可能来自不同用户操作、重复提问、分支或复制，因此不能作为身份去重依据。本次完全不根据正文或 tab 合并，只按正式 ID 保存，所以两个不同正式 ID 始终隔离。

## 修改文件

生产代码：

- `shared/chatgpt_bridge/conversation_reader.js`：等待正式 ID。
- `shared/conversation_store/identity.py`：共享的临时 ID 判断；无存储或合并逻辑。
- `shared/conversation_store/store.py`：写入前防护。
- `plugins/context_hygiene/backend/app/main.py`：旧 Reader 请求返回明确409。

验证代码：

- `tests_js/reader.test.js`：原始/编码临时 ID→正式 ID、完整正文、跳转不同 Conversation 不携带草稿。
- `tests_js/fixtures/identity_capture.cjs`：受控 DOM/Chrome API 下执行真实 Reader 和 Worker，实际 HTTP 访问独立后端。
- `tests/test_conversation_identity.py`：旧 Reader 防护、既有临时历史不清理、真实后端进程退出/启动、同正文不同身份、Atlas 兼容。
- `tests/test_store.py`：拒绝临时 ID 时连数据库文件都不会创建。

Worker 源码、数据库 schema、Atlas 代码和 Monitor 分析逻辑均未修改。

## 验证结果

独立测试库由 pytest tmp_path 创建；不使用真实 conversations.db。

|验收|实际结果|
|---|---|
|A 临时→正式|真实 Reader/Worker 源码在受控环境执行：临时 HTTP 请求0；正式阶段1 Conversation / 2 Messages，User/Assistant 完整正文及代码块一致|
|B 重复同步|正式 ID 连续同步3次，行数和正文不增加或变化|
|C 重启|独立 uvicorn 进程17928完全退出，再以进程21416启动同一库；canonical ID、两条正文及状态恢复|
|D 不同对话|同 tab、相同正文、相同 message key，canonical-A/B 分别保存，共2 Conversations / 4 Messages|
|E Atlas|原有图谱与详情 API 读取相同正式 ID 和完整原文，记录数不变|

Python 全套27通过（有1条既有 Starlette/httpx 弃用警告）。相关 Reader/Worker 8通过；Atlas 前端25通过。JS 全套基线已有3失败：Popup 两个 URL fixture 使用了字面 `<https://…>`，manifest fixture 使用 `<http://…>`；本轮不扩大范围修复这些测试，不能宣称 JS 全套全绿。

运行命令（仓库根目录）：

```powershell
.\plugins\context_hygiene\.venv\Scripts\python.exe -m pytest tests -q -s
node --test --test-name-pattern='reader|temporary draft|worker|older in-flight' tests_js/reader.test.js tests_js/worker.test.js
node --test plugins/conversation_atlas/frontend/tests/*.test.mjs
node --test tests_js/*.test.js
```

生产采集后端已从PID23764重启为PID9912，health正常，原测试对话状态可恢复。重启前后真实库均为11 Conversations / 261 Messages，全表逻辑SHA256一致：`ec831ddf7a4a63baae49503195c42b3c6698f80a08868f3960cc77295e9b1120`；schema SHA256也一致。没有迁移、清理或手工写入真实历史。

## 生效与边界

本模块尚未执行新版扩展的真实浏览器新聊天验收。受控 DOM 运行真实源码不是实际 ChatGPT DOM 验证。

手动真实验收步骤：

1. 在 Edge 的扩展管理页，重新加载原有 Desktop Pet ChatGPT Bridge（不要新增或复制扩展）。刷新 ChatGPT 页使新版 Reader 生效。
2. 新建一个聊天，发送唯一标记 `ATLAS_IDENTITY_MODULE1_001`，等待回复和正式 `/c/<id>`。
3. 核对 Reader 只发送正式 ID；用 SQLite 只读查询该用户标记，确认没有新增 local-chatgpt Conversation。历史旧临时行仍存在是预期结果，不能拿全库临时行数是否为0判定。
4. 刷新同一聊天3次，核对该正式ID只有1 Conversation；再检查已有 Atlas API 能读取它。新空 Assistant 行属于未修复边界，不能混为本次 Conversation 身份验证。

未取得正式 ID 就关闭/刷新页面的临时草稿不提供离线保全；若正文在正式 ID 到来前已经离开 DOM，本方案不保证恢复。不能将本次受控样本通过解释为所有历史消息完整性已解决。没有按不可靠的 tab 或正文关联转移临时缓存，避免把其他聊天的正文写错归属。

Message fallback key、流式空 Assistant、编辑、分支、虚拟滚动和 DOM 更新与路由变化时序仍需独立验证。两条不同正式 ID 的分支保持不同 Conversation；本次不做语义合并。既有临时历史保留可读，但继续向临时 ID 写入会收到409。

到 Module 1 为止，等待验收，不进入 Module 2。

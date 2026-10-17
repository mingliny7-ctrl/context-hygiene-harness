# Atlas 原始对话阅读保真验收记录

## 数据链与处理边界

ChatGPT 可见 DOM → 原 Reader 的稳定 Conversation/Message ID → Bridge → Collector `/sync` → `conversations.db` → Atlas API → 原文阅读器。旧 Reader 只存 `innerText`，因此部分标题、表格、图片位置和代码结构未进入旧库。新增 `message_presentations` 只存经过白名单校验的可见结构，按 `(conversation_id, message_key)` 关联原消息；`messages.content` 仍是原文与语义指纹来源。首次建表前对真实库作了 SQLite 备份。图片只接受可访问的 HTTPS 引用，不下载历史图片；临时 `blob:` 地址显示不可用。

正文指纹相同时，直接呈现采集结构。若重采页面与旧正文不同，默认读旧 `content`，并明确标注可选的“查看本次页面采集版本”；这只是两个已采集观察结果的阅读切换，不覆盖旧正文、不形成通用版本历史，也不改变 Segment 覆盖和分析缓存。真实样本 `6ad167d6-6280-83ec-ad53-dfb5df448a9b` 的首条 Assistant 旧文本长 2,946 字；结构化页面文本与之主要相差段落空白、旧文本中的“写作”两字及结尾约 11 字。末尾差异无法证明纯属格式，因此不自动合并。

`source_created_at` 才能作为原始发送时间。当前样本没有可信原始时间；界面显示“原始发送时间未知”，另将 `first_seen_at` 标成“采集于”。旧库没有保存的格式、图片和时间无法可靠重建。

## 真实页面验收

在 Edge 打开 [Atlas](http://127.0.0.1:4173/)，搜索下列 Conversation ID：

| 样本 | 验收入口 | 已观察结果 |
| --- | --- | --- |
| `6aa216a1-c604-83ec-b098-4426db9046f4` | 进入 Conversation → 浏览对话原文 | 10 条消息（5 User / 5 Assistant）分开显示；User 右侧气泡，Assistant 左侧宽正文；11 个标题、30 个代码块；无弹窗横向溢出；原始时间未知、采集时间明确标注。 |
| `6ad167d6-6280-83ec-ad53-dfb5df448a9b` | 进入 Conversation → Segment → 关键回答 → 原文；或浏览对话原文 | 保留原有 3 个 Segment 和关键回答定位。第一条回答的另一次页面采集版本可主动切换查看真实表格与可访问的公开图片；默认仍展示旧库正文。 |
| `6ace83f1-25e4-83ec-88e3-4c605c28e1b5` | 浏览对话原文 | User 原消息容器里的附件位于正文前；`blob:` 图片显示“不可用”。页面中另外的生成图片没有可靠 User/Assistant 消息身份，未强行关联。 |

图片与表格实机截图保存在任务输出目录 `outputs/original-reading/`，未提交私人对话截图到 Git。原始 ChatGPT 页面中的生成图片使用临时 `blob:` 地址，旧库没有稳定引用，Atlas 无法在重启后合法重现它们。

## 验证与回退

本轮定向测试：阅读、Store、Atlas API、身份、增量索引和语义缓存 Python 共 103 项通过；Reader、Worker、Popup、图谱和阅读器 JS 共 74 项通过。真实库对比迁移前记录：796 条原消息身份与正文指纹、8 条索引覆盖、3 个 Segment 均相同；DeepSeek 调用数保持 2。两个 SQLite 库 `PRAGMA quick_check` 均为 `ok`。Collector `/health`、Atlas `/api/atlas` 均返回 HTTP 200。

真实库备份位于 `data/conversations.reading-backup-fa5ea455bc294b618c04dbd3370d2555.db`，不纳入 Git。若要回退，先停 Collector 和 Atlas 并保留当前库，再由备份恢复原库；代码回退可单独移除展示表读取，旧 `messages` 无需迁移回写。

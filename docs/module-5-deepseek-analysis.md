# Module 5：真实 Conversation 分析与持久化复用

## 范围与运行

复用共享 Store 的只读 `read_stored_conversation`；不修改 Collector、Reader、Monitor、Atlas 前端或原始数据库 Schema。仅支持显式分析一个 Conversation，不做 Segment 或批量任务。

在项目根目录运行（使用已有虚拟环境，无新增依赖）：

```powershell
& .\plugins\context_hygiene\.venv\Scripts\python.exe -m plugins.conversation_atlas.backend.analyze_conversation --conversation-id 6aa216a1-c604-83ec-b098-4426db9046f4 --output-dir .\analysis-output
```

命令先校验顺序与内容、查询缓存，只有缓存不兼容或内容变化时才调用模型。`--regenerate` 明确要求重新生成；不要为检查连接重复运行此参数。只读接口 `GET /api/atlas/analysis/{conversation_id}` 从不调用模型，原文详情接口保持兼容。新接口需服务器加载本提交代码；本轮没有重启用户正在运行的旧 Atlas 服务。

## 配置与可迁移性

轻量 `LLMProvider.complete` 协议，目前仅实现 DeepSeek HTTP 客户端，没有 Provider 工厂或 Ollama 实现。配置优先读取环境变量，其次读取 `ATLAS_PRIVATE_ENV` 指定的私有文件，默认文件为当前用户 `%LOCALAPPDATA%\ContextHarness\deepseek.env`。不依赖原电脑绝对路径。

```dotenv
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
ATLAS_LLM_TIMEOUT=180
ATLAS_LLM_CONTEXT=131072
ATLAS_LLM_OUTPUT=4096
ATLAS_LLM_MAX_ATTEMPTS=2
```

Key 只存环境或用户私有配置，不放 Git、原始 DB 或派生 DB。迁移电脑时复制两个数据库并重新配置密钥。`ATLAS_ANALYSIS_DB` 可配置派生库位置。默认 `data/atlas_analysis.db` 与原始 `data/conversations.db` 分离。

请求超时、鉴权、余额、模型不存在、网络错误、输出截断均明确失败；无传输层自动重试。结构或引用校验失败最多补一次完整输出请求。原文超过保守 UTF-8 字节预算直接拒绝，不截断冒充全文。原文作为不可执行材料，无工具调用。

## 缓存与引用契约

独立表 `conversation_analysis` 字段：`conversation_id, source_digest, schema_version, prompt_version, model, analysis_status, analyzed_at, analysis_json, inference_json`；主键为前面三个字段。状态仅允许 `completed`。新建的是派生库，不迁移原始库。

`source_digest` 根据 canonical Conversation ID、已验证顺序中有效 User/Assistant 的稳定消息 ID、角色、完整正文计算 SHA256。忽略同步次数、写入时间与空占位。顺序不可靠时不读取正式索引。缓存复用先于模型配置与密钥检查；模型或提示词配置变化不会自动触发重新分析，结构版本不兼容才失效。

模型返回标题、摘要、结论、关键词、结论来源消息 ID 和关键 Assistant 消息 ID。Pydantic 严格校验后，Python 验证引用属于当前输入、关键回答角色为 Assistant，并从 SQLite 回读完整原文及 SHA256。校验引用存在不等于证明模型结论正确，需人工验收。

仅成功校验后事务写入；失败或中断不覆盖旧成功结果。推理结束再次核对 digest，拒绝已变化的输入。缓存不保存密钥或原文副本。回滚代码不会改变原始库；停止使用派生缓存前可备份并保留该独立文件。本模块不清理任何历史数据。

## 真实执行结果

- Conversation：`6aa216a1-c604-83ec-b098-4426db9046f4`。
- User 5 条、Assistant 5 条，共 24,852 字符；`dom_relative` 顺序。全部已存储有效输入送入模型，完整历史是否均已采集仍未知。
- source_digest：`bc9242424574c8abf793755578ee3bd3fa86e4c2e7b64a034588136c3b3996b6`。
- 模型：`deepseek-v4-pro`，实际返回 request ID `b72f8c02-d948-4442-bc54-51be8c384897`，finish_reason=`stop`。
- 标题：**DeepSeek Harness架构思想融入项目设计**。
- 主题包括 Event 与函数的关系、发布订阅、Session、State Projection、教学架构及 Bridge 排查。模型识别 5 条关键 Assistant 回答，每条均回读到对应原文。
- 最终成功调用耗时 15.067 秒；输入 10,753 tokens、输出 1,153 tokens。
- 缓存后第二次、重启分析进程后、2026-10-16 恢复任务后的独立进程均命中同一结果，新增 HTTP 请求各为 0；模型配置切换及不可达模型地址下已有缓存仍可读。

完整标题、摘要、5 条结论、关键词、引用正文、原始返回及网络计数保存在本次交付目录 `outputs/module5-deepseek-final-reference-contract/`。这些包含真实私人对话的验收产物不提交 Git。

需要透明说明：前期要求模型复写精确引用正文导致换行、段落变化，先后 4 次真实请求未通过引用或结构校验，均未标记成功。最终改为稳定 ID 引用、Python 原文回读后，1 次真实请求通过。因此整个调试过程有 5 次真实生成请求，不能表述为总共只调用一次。后续缓存读取没有新增请求。

## 验证与限制

2026-10-16 定向验证：`pytest tests/test_semantic_analysis.py -q` 27 项通过；`pytest tests/test_atlas_api.py -q` 10 项通过。覆盖缓存、内容变化、模型切换、失败与中断、引用、输入顺序、上下文限制及 API 兼容。模型异常测试采用模拟传输，与上述实际付费请求明确区分。存在 Starlette/httpx 测试工具弃用警告，无测试失败。

真实数据库 + 当前生产 ASGI 应用的进程内 HTTP 验证：缓存与原文 API 均 HTTP 200，5 条引用正文和 SHA256 相符，禁止外发 HTTP 时仍可读取。现有网络服务没有重启，不能将此证据称作已部署的浏览器验收。原分析进程退出后启动新 Python 进程已验证持久化恢复。

DeepSeek 调用前后原始库均为 30 Conversations / 695 Messages，原文、Schema、主文件 SHA256 一致；恢复验证前后主文件也一致。密钥未出现在检查的原始库、派生库或 DeepSeek JSON 验收文件中。

限制：历史完整性未知；3 条存储正文含页面“运行”等 UI 标签，与当前 DOM 有微小差异，未清洗。模型将部分建议表述成“架构升级”，人工审核应辨别提议与已实现成果；Bridge 结论也只是对原 Assistant 判断的归纳。长对话滚动窗口拼接尚未真实验收；只处理已确认顺序的一段。并发首次缓存未命中尚未做请求合并。本轮保留早期 Schema 1 的独立验证缓存，但不作为 Schema 2 兼容结果使用，不自动批量重新分析。

上次停止/重启既有 Atlas 服务被自动审批拒绝（`blocked by policy`）；本轮没有绕过该限制，没有替换用户运行中的进程。

已参考官方 JSON 输出与推理模式文档：
- https://api-docs.deepseek.com/guides/json_mode/
- https://api-docs.deepseek.com/guides/thinking_mode/

完成后停止，等待 Module 5 人工验收，不进入 Module 6。

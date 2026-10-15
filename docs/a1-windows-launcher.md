# A1：Windows 本地服务启动器

## 使用

在项目根目录双击 **Start Context Harness.vbs**。无需输入命令，不出现长期终端；窗口分别显示 Collector、Atlas 状态。只有两项服务身份与健康检查都通过，才显示“两个服务均已就绪”。关闭窗口不停止服务，启动过程中关闭也会完成有限时长的后台检查。

- Collector：`http://127.0.0.1:8000/health`，采集仍使用原有 `POST /sync`。
- Atlas：`http://127.0.0.1:4173/`，健康检查使用只读 `/api/atlas`。
- 日志：当前用户 `%LOCALAPPDATA%\ContextHarness\logs\desktop-host\<项目路径指纹>\`，包含 `collector.log`、`atlas.log`、`latest.json`。

启动入口依赖 Windows Script Host、现有 `.venv` 和 tkinter。入口会提示文件缺失；若 Windows 企业策略禁用 VBS，需要管理员允许该入口，本模块没有制作安装器或额外可执行文件。

## 最小实现

`Start Context Harness.vbs` 仅定位相对项目路径并隐藏启动已有 `pythonw.exe`。`shared/desktop_host/launcher.pyw` 是 Tk 状态窗口，工作线程执行检查；没有 Shell 命令输入或 HTTP 命令执行接口。

共享 `shared/desktop_host/launcher.py` 提供可复用 `Launcher.run()`。现有环境为 `plugins/context_hygiene/.venv/Scripts/python.exe`，两个真实入口分别为：

- Collector：`uvicorn app.main:app --app-dir plugins/context_hygiene/backend --host 127.0.0.1 --port 8000`。
- Atlas：`uvicorn plugins.conversation_atlas.backend.main:app --app-dir <项目根目录> --host 127.0.0.1 --port 4173`。

不改原始服务启动方式或业务入口。完整继承现有环境，只在子进程 PYTHONPATH 前加入项目根目录；私有 DeepSeek 配置继续由原模块读取，不查询、不展示、不记录密钥。

启动检查组合 TCP、OpenAPI 的精确应用标题和必要路径、业务健康响应。Collector 还要求 `/health` 的 status=ok；Atlas 要求真实数据模式、schemaVersion=1 与会话列表。只占用端口但身份不符或健康不可确认时，拒绝启动替代服务，不结束端口拥有者。已有健康服务直接复用，不修改它的环境和配置。

项目路径对应的 Windows 命名互斥锁防止并发双击重复拉起；进程崩溃由 OS 释放锁。服务创建使用固定参数数组、CREATE_NO_WINDOW、新进程组、日志重定向，没有 shell=True，没有随启动器窗口退出的终止逻辑。最多等待每项服务约 25 秒（单次健康请求另有 1 秒超时）。两个服务分别检查并保留各自结果。

这是本地可用性检查，不是 A2 的安全通信或认证协议；相同应用标题与路径的另一个项目副本尚不能通过健康 API 区分数据库位置。本模块不提供关闭服务、任意命令、Native Messaging、自启动或更新能力。

## 验证（2026-10-16）

| 场景 | 实际结果 |
|---|---|
| 两项均未运行 | 真实 uvicorn 启动并通过两项健康检查 |
| 重复调用共享启动能力 | 两项复用，未新增服务进程 |
| Collector 已运行，Atlas 停止 | 只启动 Atlas |
| Atlas 已运行，Collector 停止 | 只启动 Collector |
| Atlas 指向不存在的模块（受控样本） | Atlas 退出代码 3、日志含导入错误；Collector 单独报告 ready |
| 生产 Tk 窗口显示实际导入失败 | 控件明确显示“后端入口加载失败”，Collector 仍显示已运行，整体不显示成功 |
| 生产 Tk 入口自动关闭窗口 | 窗口关闭后两项服务继续健康，关闭由窗口内部测试定时器执行 |
| 真实 VBS 入口，两项均停止 | 通过 wscript.exe 执行双击所用的同一文件，启动两项后端 |
| 再次执行真实 VBS 入口 | 两项 started=false，没有重复服务进程 |
| 原文/状态/缓存 HTTP API | 原文 10 条、有效 Assistant 5 条；DeepSeek 缓存命中、模型调用 0 |
| 端口占用与错误健康响应 | 定向测试中运行真实无关 HTTP 服务；拒绝接管且无关服务保持运行 |

严格区分：没有进行人的鼠标双击或原生窗口外观人工验收，VBS 是程序调用同一入口；窗口关闭是生产 Tk 窗口的自动化测试，不冒充人工操作。浏览器 Reader 的本轮真实采集未新增验证，既有 JS 回归通过且文件未改。

真实生命周期测试仅终止该测试新建并持有 Popen 句柄的服务，没有结束其他用户进程。第一次测试在进程退出后立即检测监听端口，遇到 Windows 监听清理延迟；增加有限等待后全部场景通过，未为此修改生产启动逻辑。

最终留下 VBS 启动的两项健康服务。启动日志中的 PID 是启动进程 PID；Windows 虚拟环境可能使用子进程，不保证等于 TCP 监听 PID。

测试命令：

```powershell
& .\plugins\context_hygiene\.venv\Scripts\python.exe -m pytest tests -q
node --test tests_js/reader.test.js tests_js/reader-stability.test.js tests_js/worker.test.js tests_js/popup.test.js
```

Python **77 passed**（其中启动器 13 项）；JavaScript **24 passed**。已有 Starlette/httpx 测试工具弃用警告，不影响结果。SQLite 原始库与 Atlas 派生缓存文件 SHA256 在真实启动测试前后相同，没有执行模型请求。

真实验收产物存放本次任务交付目录 `outputs/a1-launcher/live-proof.json`，包含逐场景结果、最终启动 PID、健康地址及数据库前后哈希。用户日志和真实数据不提交 Git。

## 修改范围

- `Start Context Harness.vbs`：双击入口。
- `shared/desktop_host/__init__.py`：共享基础设施包。
- `shared/desktop_host/launcher.py`：进程启动、身份/健康检查、互斥与日志。
- `shared/desktop_host/launcher.pyw`：无终端状态窗口。
- `tests/test_desktop_launcher.py`：13 项定向测试。
- 本文档：使用方法、验证结果及边界。

Collector、Reader、Store、DeepSeek 分析/缓存和 Atlas 前端源文件均未修改。完成 A1 后停止，等待验收，不进入 A2。

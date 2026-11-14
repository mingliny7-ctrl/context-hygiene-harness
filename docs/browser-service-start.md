# 目标 A：仅通过 Collector Popup 启动服务

> 当前入口（2026-11-14）：原有 Edge Collector Popup 与桌面 **Conversation Atlas** 快捷方式均可使用。Atlas 正式地址改为 <http://127.0.0.1:14173/>；原 `4173` 已被本机 Windows 纳入保留端口范围。升级后请重载原扩展至 **1.0.7**，以更新 Worker 地址与本地访问权限；无需重新注册 Native Host。已有桌面快捷方式不含端口，无需重建。下文历史验收记录保留当时地址。

本文替代独立 Windows Launcher 的用户入口设计。A1 的后台进程管理保留在 `shared/desktop_host/launcher.py`；VBS 和 GUI 入口已取消，用户只使用原有 Edge Collector Popup。

## 用户操作

- **启动服务 / 关闭服务**：每次打开 Popup 主动核验 Collector 身份和健康，运行时显示“关闭服务”，停止时显示“启动服务”；请求进行中禁用按钮，状态未知时明确提示。启动只影响 Collector；关闭通过该 checkout 的 Windows 退出事件通知 uvicorn 结束请求并退出，不按端口杀进程。旧方式启动、没有退出事件的服务明确拒绝强制关闭。
- **打开图谱**：独立检查 Atlas；必要时仅启动 Atlas。确认健康后打开固定 `http://127.0.0.1:14173/`。失败不打开页面。Atlas 不依赖正在运行的 Collector，只读取共享历史库。

SQLite 保存数量、最近回答预览和当前 Conversation 隔离继续使用既有逻辑；服务启动状态单独显示，不充当保存回执。没有新增历史页面或 Atlas 视觉变更。

## 一次性安装（开发阶段）

推荐在文件资源管理器中双击项目根目录 `Register Native Host.cmd`。如出现本机已核实的扩展 ID 默认值，直接回车；其他电脑应填写当地实际扩展 ID。安装窗口仅用于一次性注册，不是日常服务启动器，不创建桌面快捷方式，也不启动后端。后续仍只用 Popup。

先在 Edge 扩展详情页复制该扩展的 32 字符 ID。项目根目录执行一次：

```powershell
& .\plugins\context_hygiene\.venv\Scripts\python.exe -m shared.desktop_host.install_native_host --extension-id <实际扩展ID>
```

本机实际 ID 已从当前扩展路径核实并注册；不要在另一台电脑盲目照搬该 ID。重载原扩展，接受更新的 `nativeMessaging` 和本地 Atlas 访问权限。日常只操作 Popup 两个按钮，不需要命令行。

安装器使用 Windows 已有 .NET Framework 编译器，将无窗口 EXE、私有注册配置和 manifest 放入 `%LOCALAPPDATA%\ContextHarness\native-host`；只注册 HKCU 的 `Software\Microsoft\Edge\NativeMessagingHosts\com.context_harness.desktop_host`，无需管理员权限。未来安装器可调用同一个 `install(extension_id)`。移动项目目录后需要显式重新注册；发现已注册另一个 checkout 时拒绝覆盖。

卸载注册（保留文件、数据、密钥配置及运行中的服务）：

```powershell
& .\plugins\context_hygiene\.venv\Scripts\python.exe -m shared.desktop_host.install_native_host --unregister
```

安装时保存此前注册值，卸载恢复它。未执行自动卸载或数据清理。此开发安装方式依赖 .NET Framework 编译器；未来安装程序可携带已编译组件，本轮不制作安装器。

## 通信与边界

浏览器的 `allowed_origins` 只列明可信扩展 ID，Host 再校验 origin 和本地 checkout。Worker 只接受当前扩展 `popup.html` 发出的固定按钮意图，拒绝 Reader 页面和其他来源。没有网页触发系统命令的入口。

Host 仅接受 `{"operation":"..."}`，白名单：`ping`、`check_collector`、`start_collector`、`stop_collector`、`check_atlas`、`start_atlas`。`ping` 返回固定 Host 名称和协议版本，无服务或数据库操作。拒绝额外参数、命令、路径、URL、模型配置及未知操作。请求为 UTF-8 JSON + 4 字节小端长度，最多 4096 字节，stdout 只输出一个协议帧。

无窗口 EXE 仅适配浏览器管道，使用固定 Python 解释器和 Host 脚本路径，Python Host 复用 A1 的健康检查、互斥与静默 Popen。后台服务不会随一次性 Native Host 退出而主动关闭。请求不包含 API Key 或对话内容；保留既有环境和用户私有模型配置，不写入聊天数据库。

浏览器先使用 HTTP 检查既有服务，因此服务已健康时不需要 Native Host 可用；这不意味着可以忽略 Native Host 的冷启动验证。身份判断包括精确 OpenAPI 标题、必要路径和健康字段，不能只看端口或任意 HTTP 200。

Collector 与 Atlas 是两个独立后端，互不产生启停依赖。未来 Semantic Indexer 属于 Atlas 内部模块，不是第三个服务；本轮不实现 Indexer。打开图谱只读取既有内容，不触发 DeepSeek 请求。

1.0.2 增加动态开关、退出等待与冷启动前的 Host `ping`。后台退出事件只归属于本 checkout 启动的 Collector，Atlas 启动方式不变。`operations.log` 只记录固定操作、成功与否、状态和错误代码，不记录正文或密钥。

断点恢复后的真实验证：用户确认运行状态下 Popup 显示“关闭服务”；`HOST_NOT_FOUND` 仍存在，不能标记真实 Edge 全链路通过。独立窗口隐藏 EXE 的真实 `ping` 成功，这不替代 Edge 验收。受控测试使用独立端口、Windows 事件与 SQLite，两轮实际 Collector 启动、保存回执读取、优雅退出、重启恢复通过。旧实际 Collector 尚由 A1 uvicorn 命令运行，无退出事件，安全关闭明确返回 `STOP_UNMANAGED`；没有强行结束它。

2026-10-16 原因定位：Windows ETW 记录实际 Edge 主进程 PID 15456 打开 `NativeMessagingHosts` 成功，但打开 `com.context_harness.desktop_host` 返回 `0xC0000034`（不存在），尚未进入清单读取和 EXE 启动。只读检查 Edge 实际持有的 HKCU 根句柄：32/64 位视图均只列出 `com.quark.hostclient`；同次检查开发进程的 HKCU 则列出本项目和 Quark 两项。两边 NT 根路径均显示同一用户 SID，但实际可见注册项不同。因此此前工具环境中“注册成功”的自检不能代表 Edge 能发现 Host。一次性安装必须从用户正常 Windows 会话执行；不通过复制浏览器句柄写注册表，也不更改浏览器安全策略。环境为何产生两套可见视图未进一步归因，修复验收以用户会话注册后真实 Edge ping 为准。

Edge 的 Native Messaging 错误不会作为“已保存”状态。Native Host 启动日志仅记录握手阶段、PID、退出代码、异常类型与输出字节数，不记录请求正文、环境或密钥。服务日志继续放在 A1 的 Desktop Host 日志目录。

## 验证记录

已执行：真实编译的无窗口 EXE → Python Host → 两个现有后端，四个白名单操作均正常；已运行服务 started=false；错误来源、任意命令和多余参数被拒绝；真实验证前后两个数据库哈希相同。该证据是实际进程管道验证，不能代替 Edge。

真实 Edge 第一轮：用户确认重载且看到两个按钮，但两项按钮均提示无法连接本地启动组件。采集后端实际正常。已定位并修复“已运行仍强依赖 Host”的交互错误；Edge Native Host 根因与最终验收结果需在交付前补充，当前不得标为通过。

后续诊断：用户手动 Console 返回 `sendNativeMessage is not a function`，并附 Reader 页面的 Non-prefix 警告。该诊断上下文未暴露 Native Messaging API，不能作为 Edge 不支持该 API 或 Host 故障根因的证据。Reader 的警告指向同消息正文观察变化，未作为本轮启动问题的修复范围。本轮 Reader 未修改。

扩展 1.0.1 在 Worker 中检查 Native API 是否可用，并将浏览器错误分为 `NATIVE_API_UNAVAILABLE`、`HOST_NOT_FOUND`、`HOST_FORBIDDEN`、`HOST_START_FAILED`、`HOST_EXITED` 等；Popup 直接显示阶段代码，减少手动 Console 上下文误选。`desktopHostDiagnostic` 仅保存阶段代码、固定操作、Worker 版本、扩展 ID 和时间，不包含原始消息或配置。为真实冷启动验证，仅停止已核实命令完全一致的上轮 A1 Atlas 测试进程，Collector 保持健康；不停止其他项目进程。

用户继续反馈旧的无阶段代码提示后，检查 Edge 当前扩展配置记录：加载路径正确，`service_worker_registration_info.version` 仍为 `1.0.0`，最后更新时间 `2026-10-15T19:02:58.475335+00:00`，早于 1.0.1 Worker/manifest 文件修改时间 `2026-10-15T19:44:37.176075+00:00`。这是旧注册状态证据，仍需实际重载后的按钮结果确认，不作为 Native Host 冷启动通过的证据。

自动化测试覆盖服务隔离、健康前不跳页、重复点击合并、固定图谱 URL、未知来源/操作拒绝、现有服务不要求 Native Host、Popup 按钮状态及既有采集回归。最终数量以交付测试输出为准。

官方协议依据：[Microsoft Edge Native Messaging](https://learn.microsoft.com/zh-cn/microsoft-edge/extensions-chromium/developer-guide/native-messaging)、[Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)。没有修改浏览器安全策略，也没有开启任意命令接口。

## 1.0.3：Collector 端口兼容修复与 Edge 反馈

用户已批准 Collector 改用 `http://127.0.0.1:18000`，Atlas 保持 `http://127.0.0.1:4173/`。Windows 当前保留范围 7998–8097 导致原 8000 绑定失败（WinError 10013）；不修改系统保留范围。Worker 同步、Popup 状态查询、扩展权限和 Host 服务配置一起更新。手动启动 Collector 时也必须使用 18000。升级后需重载扩展 1.0.3，无需重新注册 Host。

冷态 Collector 状态检查和两项冷启动均先验证 Native Host ping；健康的既有服务仍可直接复用。端口绑定权限错误单独分类，不再误报为文件访问权限。

本轮实际独立 Native EXE 验证：ping → Collector 停止 → 启动 18000 → 重复启动 started=false → 健康 → 优雅关闭 → 确认停止；Atlas 全程健康。分析缓存文件哈希未变化。该验证没有通过 Edge，不能替代原生 Popup 验收。用户已从正常 Windows 会话完成一次性注册，真实 Edge 通信仍待本轮反馈。测试：42 项 Python、34 项 JavaScript 通过（包含 Reader 既有测试，未修改 Reader 核心）。

最终用户反馈（2026-10-16）：重载 1.0.3 后，按要求点击“启动服务”和“打开图谱”，用户确认“实际结果正常运行，符合预期”。随后工具实际健康检查确认 Collector 18000 与 Atlas 4173 均 ready，Collector 使用 shared.desktop_host.collector_control 入口。新版冷态启动在执行服务操作前强制校验 Native Host ping，因此用户冷态启动成功是浏览器握手成功的间接证据；工具当前可见 operations.log 仍止于独立 EXE 验证，未取得该次 Edge ping 的独立日志，不冒充直接抓包证据。

验收范围：用户确认 Edge 启动采集、打开运行中的图谱符合预期；安全停止、重复启动与重启恢复已在独立实际进程及自动化中验证。本轮尚未单独取得用户对 Edge 关闭服务、重开 Popup 状态恢复以及 Atlas 冷态启动的逐项反馈。保留此限制，不以自动化代替这些浏览器项目。自动化总计 46 项 Python、34 项 JavaScript 通过。没有修改 Reader 核心、Store、原始数据库、DeepSeek 客户端或 Atlas 前端。

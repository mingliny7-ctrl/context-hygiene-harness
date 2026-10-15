# 目标 A：仅通过 Collector Popup 启动服务

本文替代独立 Windows Launcher 的用户入口设计。A1 的后台进程管理保留在 `shared/desktop_host/launcher.py`；VBS 和 GUI 入口已取消，用户只使用原有 Edge Collector Popup。

## 用户操作

- **启动采集**：先通过 HTTP 校验 Collector 的应用身份与健康；已运行直接显示“采集服务运行中”。未确认运行时通过 Native Host 检查并静默启动 Collector；不打开网页、不启动 Atlas。
- **打开图谱**：独立检查 Atlas；必要时仅启动 Atlas。确认健康后打开固定 `http://127.0.0.1:4173/`。失败不打开页面。Atlas 不依赖正在运行的 Collector，只读取共享历史库。

SQLite 保存数量、最近回答预览和当前 Conversation 隔离继续使用既有逻辑；服务启动状态单独显示，不充当保存回执。没有新增历史页面或 Atlas 视觉变更。

## 一次性安装（开发阶段）

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

Host 仅接受 `{"operation":"..."}`，白名单：`check_collector`、`start_collector`、`check_atlas`、`start_atlas`。拒绝额外参数、命令、路径、URL、模型配置及未知操作。请求为 UTF-8 JSON + 4 字节小端长度，最多 4096 字节，stdout 只输出一个协议帧。

无窗口 EXE 仅适配浏览器管道，使用固定 Python 解释器和 Host 脚本路径，Python Host 复用 A1 的健康检查、互斥与静默 Popen。后台服务不会随一次性 Native Host 退出而主动关闭。请求不包含 API Key 或对话内容；保留既有环境和用户私有模型配置，不写入聊天数据库。

浏览器先使用 HTTP 检查既有服务，因此服务已健康时不需要 Native Host 可用；这不意味着可以忽略 Native Host 的冷启动验证。身份判断包括精确 OpenAPI 标题、必要路径和健康字段，不能只看端口或任意 HTTP 200。

Edge 的 Native Messaging 错误不会作为“已保存”状态。Native Host 启动日志仅记录握手阶段、PID、退出代码、异常类型与输出字节数，不记录请求正文、环境或密钥。服务日志继续放在 A1 的 Desktop Host 日志目录。

## 验证记录

已执行：真实编译的无窗口 EXE → Python Host → 两个现有后端，四个白名单操作均正常；已运行服务 started=false；错误来源、任意命令和多余参数被拒绝；真实验证前后两个数据库哈希相同。该证据是实际进程管道验证，不能代替 Edge。

真实 Edge 第一轮：用户确认重载且看到两个按钮，但两项按钮均提示无法连接本地启动组件。采集后端实际正常。已定位并修复“已运行仍强依赖 Host”的交互错误；Edge Native Host 根因与最终验收结果需在交付前补充，当前不得标为通过。

后续诊断：用户手动 Console 返回 `sendNativeMessage is not a function`，并附 Reader 页面的 Non-prefix 警告。该诊断上下文未暴露 Native Messaging API，不能作为 Edge 不支持该 API 或 Host 故障根因的证据。Reader 的警告指向同消息正文观察变化，未作为本轮启动问题的修复范围。本轮 Reader 未修改。

扩展 1.0.1 在 Worker 中检查 Native API 是否可用，并将浏览器错误分为 `NATIVE_API_UNAVAILABLE`、`HOST_NOT_FOUND`、`HOST_FORBIDDEN`、`HOST_START_FAILED`、`HOST_EXITED` 等；Popup 直接显示阶段代码，减少手动 Console 上下文误选。`desktopHostDiagnostic` 仅保存阶段代码、固定操作、Worker 版本、扩展 ID 和时间，不包含原始消息或配置。为真实冷启动验证，仅停止已核实命令完全一致的上轮 A1 Atlas 测试进程，Collector 保持健康；不停止其他项目进程。

用户继续反馈旧的无阶段代码提示后，检查 Edge 当前扩展配置记录：加载路径正确，`service_worker_registration_info.version` 仍为 `1.0.0`，最后更新时间 `2026-10-15T19:02:58.475335+00:00`，早于 1.0.1 Worker/manifest 文件修改时间 `2026-10-15T19:44:37.176075+00:00`。这是旧注册状态证据，仍需实际重载后的按钮结果确认，不作为 Native Host 冷启动通过的证据。

自动化测试覆盖服务隔离、健康前不跳页、重复点击合并、固定图谱 URL、未知来源/操作拒绝、现有服务不要求 Native Host、Popup 按钮状态及既有采集回归。最终数量以交付测试输出为准。

官方协议依据：[Microsoft Edge Native Messaging](https://learn.microsoft.com/zh-cn/microsoft-edge/extensions-chromium/developer-guide/native-messaging)、[Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)。没有修改浏览器安全策略，也没有开启任意命令接口。

# Conversation Atlas 状态 · 2026-10-14

当前阶段：前端交互原型完成，等待用户 UI 验收。暂停后端、数据库、索引和 AI 集成。

## 已确认现状与改动边界

- 基线 `main @ 176cebc458c88eb02b56a5d666fb2f12ee0f5143`，开始前工作区干净。
- 原有前端仅 `shared/chatgpt_bridge/popup.{html,css,js}`，没有 Web 框架、package.json 或 Atlas 页面。
- 本轮新增独立 `plugins/conversation_atlas/frontend`，沿用原生 HTML/CSS/JavaScript ESM。Canvas 粒子、SVG 数据连线，无前端依赖或构建工具。
- 未修改 `shared/`、`plugins/context_hygiene/`、现有测试、数据库或 FastAPI；只新增 Atlas 前端 / 启动脚本和更新文档。
- 本地分支 `feat/conversation-atlas-prototype`；交付检查点 SHA 见对话输出中的 `git-status.txt`。没有推送远程。

## 已实现的可操作功能

- 首页动态粒子核心、分类粒子星球、最近 Conversation 气泡、细曲线与底部居中搜索。
- `Overview → Category → Conversation → Segment`，展开后核心保留左侧、分类高亮，子节点按列纵向排列，平滑贝塞尔连接。
- 节点 / 连线 720ms 展开与收拢，稳定 ID 复用；快速返回重开不会遗留不可交互的离场节点。
- Inspector 摘要、结论、关键词、时间、稳定 ID 与模拟消息范围；关闭保留图谱状态。原始对话入口明确禁用。
- 始终可见的返回 Atlas、局部阶段收拢、最近对话列表、指南、动效暂停 / 继续。
- 本地关键词搜索、空结果、搜索结果导航至 Conversation / Segment，自动展开父级并滚动定位。
- `/` 聚焦搜索、Esc 关闭浮层 / Inspector、按钮键盘访问；系统减少动态效果、隐藏页面和显式暂停时取消 RAF。
- 桌面优先；窄屏图谱横向滚动，保留左→右关系，Inspector 为可关闭的右侧覆盖面板。

## 模拟内容与未实现项

5 个分类、15 个 Conversation、45 个 Segment 的标题、摘要、结论、时间、消息范围均为模拟。来源与原型能力在页面明确标识；统计从数据计算。`loadAtlas()` 作为异步读取边界，与渲染 / 布局分离。

搜索为本地关键词匹配，未接入语义检索、模型或真实历史；分类关键词也参与匹配。未实现原文跳转、数据库集成、AI 分类 / Segment、索引、删除 / 恢复、全局时间轴图谱。不能把模拟消息键当作真实 Store ID。

参考视频已实际读取：`E:/Dolode/video_Opus5.5重构了我的创作面板..._0.mp4`（1920×1080，22.43 秒）。采用其暗色粒子空间、左侧锚点→右侧曲线和右侧 Inspector 结构；核心使用轻量三维投影点阵与琥珀色发光线簇，未复刻视频的火焰材质与后处理，不声称逐像素相同。

## 测试证据

| 检查 | 实际结果 |
| --- | --- |
| Atlas Node 原生测试 | 19/19 通过：4 数据、9 布局、6 粒子生命周期 |
| 原有 Python 测试 | 11 通过，1 个既有 Starlette/httpx 弃用警告 |
| 原有 JavaScript 测试 | 5 通过 / 3 失败，与修改前一致 |
| HTTP 首页 / app.mjs | 200；ESM `text/javascript` |
| 浏览器控制台 | 实测过程 0 error / 0 warn |
| Git whitespace | `git diff --check` 通过 |
| 浏览器断点 | 1440×960、1440×720、390×844、1920×1080 |

原有 JS 失败：`popup.test.js:57` 当前会话恢复断言、`:81` 已删除会话提示断言、`reader.test.js:126` manifest host permission 断言。基线与回归日志均保留。测试中 URL / host permission 使用了字面量 `<...>`；本轮没有修改这些用例或原有逻辑，也没有将失败标成通过。

浏览器已实际验证：分类→对话→阶段；阶段详情与消息范围；关闭详情不收拢；返回平滑恢复 10 个首页节点；搜索 / 空结果 / 搜索直接定位阶段；最近对话跨分类导航；指南；暂停 / 继续；快捷键；快速收拢重开；局部阶段收拢；窄屏返回入口与搜索栏。

视觉 QA 发现并修复：首页气泡超出画布、粒子过暗、小高度窗口搜索选中节点在视口之外。修复后首页全部 10 个节点在 1388×573 与 1000×500 画布内；1440×720 选中底部 Segment 后完整滚动进入视口。参考对比和最终截图见 `design-qa.md`。

## 运行与后续

```powershell
cd D:\study\desktop-pet-harness
python -m http.server 4173 --bind 127.0.0.1 --directory plugins/conversation_atlas/frontend
```

访问 <http://127.0.0.1:4173/>。交付时服务保持运行。无需 FastAPI / npm / 数据库。

下一步只接收用户视觉与交互反馈。UI 验收通过前不自动进入后端阶段。

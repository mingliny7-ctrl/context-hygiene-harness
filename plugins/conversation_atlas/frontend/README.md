# Conversation Atlas 前端交互原型

本轮只交付可操作的 UI，等待视觉验收。使用现有项目的原生 HTML / CSS / JavaScript 技术栈；无 npm 依赖、构建步骤或后端服务依赖。

## 启动

在仓库根目录执行：

```powershell
python -m http.server 4173 --bind 127.0.0.1 --directory plugins/conversation_atlas/frontend
```

也可执行 `./scripts/start_atlas.ps1`（自定义端口：`-Port 4180`）。打开 <http://127.0.0.1:4173/>。按 Ctrl+C 停止服务。不要直接双击 HTML：浏览器需要 HTTP 才能加载 ESM 模块。

## 验收路径

1. 首页：5 个分类粒子星球、每个分类最近的 Conversation、中央动态粒子核心和底部搜索。
2. 点击“Agent 工程”：核心移至左侧，分类成为锚点，对话在右侧按创建时间纵向展开。
3. 点击“让 Agent 完成一次真实任务”：再向右展开 3 个 Segment，按阶段顺序排列。
4. 点击任意 Segment：右侧 Inspector 显示摘要、结论、关键词、时间与模拟消息范围。
5. 关闭 Inspector：层级和选中节点保留。再次点击节点可重新打开。
6. 点击 Conversation 详情中的“收拢讨论阶段”，或点击当前分类收拢阶段；点击“返回 Atlas”收拢整个分支。
7. 搜索“RAG”或“设计”：点击 Conversation / Segment 结果自动展开父级并定位节点。没有匹配时显示空结果提示。
8. 测试最近对话、指南、动效暂停 / 继续、Tab、Enter、`/` 搜索快捷键和 Esc 关闭。

节点与连线的展开 / 返回使用 720ms 连续过渡；快速重复切换会取消离场删除计时器，复用同 ID 节点。尊重系统“减少动态效果”，页面隐藏或显式暂停时停止动画循环。图谱在窄屏保持左→右结构，可横向滚动；小窗口的详情使用右侧覆盖面板，可关闭后继续探索。当前以桌面体验为主。

## 文件与边界

| 文件 | 职责 |
| --- | --- |
| `index.html`、`styles.css` | 页面结构、独立样式、响应式布局与过渡 |
| `app.mjs` | UI 状态、节点选择、Inspector、关键词搜索和键盘交互 |
| `layout.mjs` | 纯数据驱动的节点 / 连线布局；不读取 DOM，不导入模拟数据 |
| `particles.mjs` | Canvas 粒子渲染与动画生命周期；不参与业务状态 |
| `data/mock-atlas.mjs` | 明确标注来源的模拟数据：5 Category / 15 Conversation / 45 Segment |
| `data/atlas-source.mjs` | 可替换的数据读取边界和本地关键词匹配 |
| `tests/*.test.mjs` | 数据关联、布局与粒子生命周期的 Node 原生测试 |
| `icons/` | Heroicons 本地 SVG 图标及 MIT 许可证，运行时无需联网 |

`Category.id → Conversation.categoryId` 与 `Conversation.id → Segment.conversationId` 为稳定关系。每个 Segment 同时包含模拟 `messageRange` 键和可读 `messageIndexRange`。不能把这些模拟 ID 当作 SQLite 中的真实消息 ID。

后续真实 API 只需替换数据边界、验证返回契约，再逐步处理加载 / 错误状态；本轮没有真实 API 调用。数据与布局都不依据某个标题或业务内容写死坐标。

代码命名说明：`loadAtlas`、`searchAtlas`、`computeLayout`、`ParticleField` 以及数据契约字段属于【🟢 本地自定义名称】，由项目统一约定；`ResizeObserver`、`requestAnimationFrame`、`CanvasRenderingContext2D` 等属于【🔒 浏览器官方固定 API】，不可随意改名。本原型没有引入第三方 SDK。

## 模拟与未实现项

- 分类、Conversation、Segment、摘要、结论、时间和消息范围均为模拟；首页统计直接从模拟数据计算。
- 搜索是本地关键词 AND 匹配，可接收自然语言输入，但不理解自然语言语义，不调用模型；分类关键词也参与关联匹配。
- 原文跳转明确禁用并标为“尚未接入”。没有伪造跳转或读取真实历史。
- 本轮不实现数据库、AI 分类 / Segment、全文 / 向量索引、删除 / 恢复或全局时间轴视图。
- 不读取或修改 `shared/conversation_store`、`shared/chatgpt_bridge`、`plugins/context_hygiene`；不启动 FastAPI。

参考视频在 `E:/Dolode/video_Opus5.5重构了我的创作面板..._0.mp4`，已实际读取 2s、14s、19s 等关键画面。此原型借鉴暗色空间、发光粒子、左侧锚点→右侧曲线和右侧详情；使用轻量 Canvas 3D 投影点阵，没有声称与视频中的火焰材质 / 后处理逐像素一致。视频保留原位置，未加入 Git。

## 测试

在仓库根目录执行：

```powershell
node --test plugins/conversation_atlas/frontend/tests/data.test.mjs plugins/conversation_atlas/frontend/tests/layout.test.mjs plugins/conversation_atlas/frontend/tests/particles.test.mjs
```

浏览器实际交互、截图、基线回归结果见仓库根目录 `STATUS.md`、`design-qa.md`，本次交付的截图和日志另保存在对话 outputs 目录。

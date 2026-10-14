/**
 * Small, deterministic fixture for the Conversation Atlas visual prototype.
 * All text, IDs, counts and message references below are fictional local data.
 * No original conversations, remote URLs or backend connection are used.
 *
 * Contract:
 * - Every entity has id, kind, title, summary, keywords, outcomes and ISO times.
 * - Categories own conversations through conversation.categoryId.
 * - Conversations own segments through segment.conversationId.
 * - Segment messageRange references stable mock message keys; the separate
 *   messageIndexRange uses inclusive, one-based positions in that conversation.
 * - Coordinates and rendering state deliberately do not belong in this module.
 */

const categoryDefinitions = [
  {
    id: 'cat-agent', kind: 'category', title: 'Agent 工程', color: '#67d9bc',
    description: '让模型从回答问题，走向完成任务。',
    summary: '围绕工具调用、检索和可靠运行，整理可以落地的 Agent 工程实践。',
    keywords: ['Agent', '工具调用', 'RAG', '工程'],
    outcomes: ['形成可运行、可解释、可演示的应用原型。'],
  },
  {
    id: 'cat-design', kind: 'category', title: '产品设计', color: '#a99adf',
    description: '把复杂的信息，变成直觉的体验。',
    summary: '从信息层级到交互动效，探索 Conversation Atlas 的使用体验。',
    keywords: ['设计', '交互', 'Atlas', '体验'],
    outcomes: ['以清晰的层级和反馈建立视觉基准。'],
  },
  {
    id: 'cat-learning', kind: 'category', title: '知识与学习', color: '#ceb779',
    description: '让每一次理解，都留下可连接的线索。',
    summary: '将学习路径、实践记录和复习方法连接成可持续积累的知识网络。',
    keywords: ['学习', '知识', '面试', '实践'],
    outcomes: ['把理解沉淀为可复用的代码、笔记和表达。'],
  },
  {
    id: 'cat-creative', kind: 'category', title: '创意实验', color: '#d392ae',
    description: '给尚未成形的念头，一点自由的空间。',
    summary: '保存关于写作、声音与视觉叙事的小实验，连接灵感与下一步行动。',
    keywords: ['创意', '写作', '视觉', '实验'],
    outcomes: ['用小规模原型验证一个新想法。'],
  },
  {
    id: 'cat-life', kind: 'category', title: '生活灵感', color: '#83abc9',
    description: '在日常的细节里，发现新的连接。',
    summary: '从散步、阅读与专注习惯中，记录值得保留的日常灵感。',
    keywords: ['生活', '阅读', '专注', '灵感'],
    outcomes: ['让观察成为可以回访的个人记录。'],
  },
];

/** Seed records contain explicit entity IDs; adding a record never renumbers siblings. */
const conversationDefinitions = [
  {
    id: 'conv-agent-loop', categoryId: 'cat-agent', title: '让 Agent 完成一次真实任务',
    summary: '把工具调用组织成可控的循环，让模型的下一步与实际执行结果保持一致。',
    keywords: ['Agent', '工具调用', '循环', 'Tool Calling'],
    outcomes: ['先保存工具结果，再判断是否继续。', '用步数限制和明确出口避免无限循环。'],
    createdAt: '2026-10-08T08:30:00Z', updatedAt: '2026-10-13T07:20:00Z',
    segments: [
      { id: 'seg-agent-loop-intent', title: '从意图到工具', summary: '将用户的需求映射为可执行的工具输入，并确认每个参数来自哪里。', keywords: ['意图', '参数'], outcomes: ['工具接口接收明确的业务参数。'] },
      { id: 'seg-agent-loop-feedback', title: '把执行结果交回模型', summary: '工具执行后，将真实结果放回上下文，模型才能基于事实决定下一步。', keywords: ['工具结果', '上下文'], outcomes: ['每次调用都有对应的结果记录。'] },
      { id: 'seg-agent-loop-exit', title: '给循环一个可靠出口', summary: '同时处理完成任务、达到步数限制和执行失败三种结束路径。', keywords: ['退出条件', '异常'], outcomes: ['失败时显示原因和可恢复的下一步。'] },
    ],
  },
  {
    id: 'conv-agent-rag', categoryId: 'cat-agent', title: '给回答一条可追溯的证据链',
    summary: '从资料切分到来源展示，设计一个能够解释引用依据的轻量检索流程。',
    keywords: ['RAG', '检索', '引用', '知识库'],
    outcomes: ['检索结果保留原文和来源。', '没有证据时明确说明缺口。'],
    createdAt: '2026-10-10T04:10:00Z', updatedAt: '2026-10-13T09:05:00Z',
    segments: [
      { id: 'seg-agent-rag-chunk', title: '以语义边界切分资料', summary: '优先保留标题与段落的关系，让每个片段仍然具有可理解的上下文。', keywords: ['切分', '段落'], outcomes: ['每个片段带有稳定来源标识。'] },
      { id: 'seg-agent-rag-retrieve', title: '先找证据，再组织回答', summary: '检索阶段先筛出相关片段，再把有限的证据交给模型生成回答。', keywords: ['召回', '证据'], outcomes: ['答案只依赖当前可用的资料。'] },
      { id: 'seg-agent-rag-source', title: '让引用可以被检查', summary: '在回答旁展示引用片段及其位置，方便用户核对和继续阅读。', keywords: ['来源', '可追溯'], outcomes: ['用户可以回到支撑结论的原文。'] },
    ],
  },
  {
    id: 'conv-agent-errors', categoryId: 'cat-agent', title: '把失败也设计进工作流',
    summary: '区分可重试错误与需要用户处理的问题，让失败路径同样清楚、可恢复。',
    keywords: ['异常处理', '超时', '重试', '可靠性'],
    outcomes: ['限制重试次数并保留诊断信息。', '把执行状态转化为用户可以理解的反馈。'],
    createdAt: '2026-10-12T03:00:00Z', updatedAt: '2026-10-14T01:15:00Z',
    segments: [
      { id: 'seg-agent-errors-classify', title: '先判断失败发生在哪里', summary: '通过输入、调用和返回三个位置，定位失败属于参数、服务还是结果处理。', keywords: ['Debug', '诊断'], outcomes: ['日志说明失败阶段与简短原因。'] },
      { id: 'seg-agent-errors-retry', title: '给重试设置边界', summary: '仅对临时故障进行有限重试，避免把错误输入反复发送。', keywords: ['重试', '边界'], outcomes: ['临时失败具有明确的重试上限。'] },
      { id: 'seg-agent-errors-resume', title: '保留继续执行的起点', summary: '保存已完成步骤与失败位置，使用户能从最近有效状态继续。', keywords: ['状态', '恢复'], outcomes: ['恢复执行无需重复已经成功的操作。'] },
    ],
  },
  {
    id: 'conv-design-atlas', categoryId: 'cat-design', title: '把对话放回一张星图',
    summary: '用空间关系表达主题与对话的连接，让信息探索从列表阅读变成自然浏览。',
    keywords: ['Atlas', '图谱', '空间', '信息层级'],
    outcomes: ['首页展示主题之间的空间关系。', '展开后保持左到右的阅读方向。'],
    createdAt: '2026-10-09T01:30:00Z', updatedAt: '2026-10-13T11:40:00Z',
    segments: [
      { id: 'seg-design-atlas-core', title: '中央核心建立空间重心', summary: '用柔和的粒子核心承接整张图谱，让分散的主题仍然具有共同的起点。', keywords: ['粒子', '核心'], outcomes: ['视觉焦点保持稳定。'] },
      { id: 'seg-design-atlas-hierarchy', title: '层级沿阅读方向展开', summary: '分类、对话与片段依次向右展开，让用户能追踪当前内容来自哪里。', keywords: ['层级', '布局'], outcomes: ['节点位置表达父子关系。'] },
      { id: 'seg-design-atlas-inspector', title: '详情留在探索路径旁', summary: '将摘要和结论放入右侧 Inspector，同时保留图谱中的选中位置。', keywords: ['Inspector', '详情'], outcomes: ['阅读详情不打断图谱浏览。'] },
    ],
  },
  {
    id: 'conv-design-motion', categoryId: 'cat-design', title: '让展开过程讲清楚关系',
    summary: '通过连续的位置变化与连线过渡，告诉用户展开来自哪里、返回会去哪里。',
    keywords: ['动画', '过渡', '贝塞尔', '交互'],
    outcomes: ['同一节点在视图变化中保留身份。', '尊重减少动态效果的系统偏好。'],
    createdAt: '2026-10-11T06:40:00Z', updatedAt: '2026-10-13T12:10:00Z',
    segments: [
      { id: 'seg-design-motion-position', title: '让位置变化具有连续性', summary: '布局切换时保留节点，再从旧位置移动到新位置，避免内容突然替换。', keywords: ['连续', '过渡'], outcomes: ['展开与收拢共享一致的运动语言。'] },
      { id: 'seg-design-motion-curves', title: '用曲线表达连接', summary: '平滑曲线连接父节点与子节点，使纵向排列的内容保持柔和的层次。', keywords: ['贝塞尔', '连线'], outcomes: ['线条不会抢占节点内容的注意力。'] },
      { id: 'seg-design-motion-access', title: '让动态效果可以安静下来', summary: '在减少动态效果模式下降低位移与粒子运动，保留必要的选中反馈。', keywords: ['无障碍', '减少动态'], outcomes: ['静态状态仍然能够读懂关系。'] },
    ],
  },
  {
    id: 'conv-design-search', categoryId: 'cat-design', title: '一句话，找到想回看的对话',
    summary: '用底部搜索入口连接自由探索和定向查找，并清楚表达当前的原型能力。',
    keywords: ['搜索', '自然语言', '反馈', '原型'],
    outcomes: ['输入后返回可点击的本地匹配结果。', '明确展示当前使用的是模拟数据。'],
    createdAt: '2026-10-13T02:00:00Z', updatedAt: '2026-10-14T02:30:00Z',
    segments: [
      { id: 'seg-design-search-entry', title: '把搜索入口放在探索的边缘', summary: '底部居中的输入栏保持易发现，同时让中央空间留给图谱。', keywords: ['搜索栏', '布局'], outcomes: ['搜索入口随图谱视图持续可用。'] },
      { id: 'seg-design-search-results', title: '让结果带着上下文出现', summary: '结果同时显示标题、摘要与所属分类，帮助用户判断是否值得打开。', keywords: ['结果', '上下文'], outcomes: ['点击结果能定位到对应层级。'] },
      { id: 'seg-design-search-empty', title: '为空结果提供下一步', summary: '无匹配时显示清楚的状态和可尝试关键词，避免让输入无声消失。', keywords: ['空状态', '提示'], outcomes: ['原型搜索不会假装已经接入语义模型。'] },
    ],
  },
  {
    id: 'conv-learning-path', categoryId: 'cat-learning', title: '一条面向交付的学习路径',
    summary: '以真实项目为主线，把学习拆成可以写出、运行并解释的小步骤。',
    keywords: ['学习', '项目', '交付', '实践'],
    outcomes: ['每个阶段留下可检查的产出。', '先解决当前项目所需的概念。'],
    createdAt: '2026-10-07T09:00:00Z', updatedAt: '2026-10-12T06:10:00Z',
    segments: [
      { id: 'seg-learning-path-atom', title: '一次只推进一个关键概念', summary: '把一个完整能力拆成最小可练习单元，确认理解后再连接下一步。', keywords: ['原子概念', '拆分'], outcomes: ['每个练习都能解释它在项目中的作用。'] },
      { id: 'seg-learning-path-code', title: '让代码暴露理解的缺口', summary: '先写最小实现，再根据报错和数据流找到真正缺少的知识。', keywords: ['代码', '诊断'], outcomes: ['练习以运行结果作为反馈。'] },
      { id: 'seg-learning-path-output', title: '把学习变成可展示成果', summary: '在阶段结束时整理代码、验证证据与简短说明，留下可以复用的资产。', keywords: ['成果', 'README'], outcomes: ['每阶段有一份可解释的交付记录。'] },
    ],
  },
  {
    id: 'conv-learning-debug', categoryId: 'cat-learning', title: '把报错变成定位线索',
    summary: '沿数据流检查输入、状态和输出，把 Debug 变成可以重复使用的判断过程。',
    keywords: ['Debug', '排错', '数据流', '测试'],
    outcomes: ['通过最小复现缩小问题范围。', '用一条验证证明修复有效。'],
    createdAt: '2026-10-10T09:20:00Z', updatedAt: '2026-10-13T05:50:00Z',
    segments: [
      { id: 'seg-learning-debug-repro', title: '先留下最小复现', summary: '固定触发问题的输入，减少无关步骤，让每次修改都能快速验证。', keywords: ['复现', '输入'], outcomes: ['问题能够以一段清楚的操作说明重现。'] },
      { id: 'seg-learning-debug-flow', title: '追踪数据在哪里变化', summary: '从入口向后检查每个阶段的值与类型，找到首次偏离预期的位置。', keywords: ['数据流', '类型'], outcomes: ['先定位错误边界，再修改代码。'] },
      { id: 'seg-learning-debug-check', title: '验证修复与相邻情况', summary: '重新运行原始输入，再覆盖一个相关变体，确认修复没有依赖巧合。', keywords: ['验证', '变体'], outcomes: ['记录原问题与一个相邻条件的验证结果。'] },
    ],
  },
  {
    id: 'conv-learning-interview', categoryId: 'cat-learning', title: '把项目讲成一段可信的经历',
    summary: '围绕问题、选择和验证结果组织面试表达，让工程决策与实际产出相互支撑。',
    keywords: ['面试', '简历', '表达', '工程决策'],
    outcomes: ['用具体行为解释自己的贡献。', '清楚说明原型边界与下一步。'],
    createdAt: '2026-10-12T07:10:00Z', updatedAt: '2026-10-14T00:40:00Z',
    segments: [
      { id: 'seg-learning-interview-problem', title: '从具体问题开始讲', summary: '先说明用户遇到什么困难，以及原来的流程为什么不够好。', keywords: ['问题', '业务'], outcomes: ['项目介绍有清楚的使用场景。'] },
      { id: 'seg-learning-interview-choice', title: '讲清楚一个关键取舍', summary: '选择一个影响交付的技术决策，说明约束、备选方案和当前选择的理由。', keywords: ['取舍', '架构'], outcomes: ['技术选择能够与业务目标对应。'] },
      { id: 'seg-learning-interview-proof', title: '用验证证据结束', summary: '展示可运行流程与测试结果，并准确区分已实现内容和计划内容。', keywords: ['验证', '证据'], outcomes: ['项目陈述与实际演示保持一致。'] },
    ],
  },
  {
    id: 'conv-creative-writing', categoryId: 'cat-creative', title: '给灵感留一张未完成的纸',
    summary: '从一句观察开始，保留写作草稿的变化过程，让不同时间的念头可以重遇。',
    keywords: ['写作', '草稿', '灵感', '叙事'],
    outcomes: ['先保存细节，再判断是否值得展开。', '为每个草稿留下可继续的方向。'],
    createdAt: '2026-10-08T12:30:00Z', updatedAt: '2026-10-12T10:10:00Z',
    segments: [
      { id: 'seg-creative-writing-observe', title: '捕捉一个具体细节', summary: '记录一个声音、动作或光线变化，让文字从可感知的场景出发。', keywords: ['观察', '细节'], outcomes: ['草稿有一个明确的感官入口。'] },
      { id: 'seg-creative-writing-connect', title: '把细节连接到一个情绪', summary: '探索同一场景中的情绪变化，找到值得继续叙述的张力。', keywords: ['情绪', '连接'], outcomes: ['一段文字围绕一个情绪方向展开。'] },
      { id: 'seg-creative-writing-revisit', title: '为下一次回访留一个问题', summary: '记录还没有解决的选择，让后续写作能迅速找到继续的位置。', keywords: ['回访', '问题'], outcomes: ['未完成草稿具有清楚的下一步。'] },
    ],
  },
  {
    id: 'conv-creative-sound', categoryId: 'cat-creative', title: '用声音记录一座城市',
    summary: '想象一份以环境声音为线索的城市日记，让地点和记忆形成新的关联。',
    keywords: ['声音', '城市', '日记', '实验'],
    outcomes: ['用同一结构记录时间、地点与感受。', '先用三个声音片段验证叙事方式。'],
    createdAt: '2026-10-11T11:00:00Z', updatedAt: '2026-10-13T10:50:00Z',
    segments: [
      { id: 'seg-creative-sound-scenes', title: '选择三个不同的城市时刻', summary: '用清晨、午后与夜晚三个场景，形成一条简单的时间线。', keywords: ['场景', '时间'], outcomes: ['每个声音片段有明确的环境说明。'] },
      { id: 'seg-creative-sound-notes', title: '给声音配一句观察', summary: '短句只记录现场的感受，保留声音本身的想象空间。', keywords: ['观察', '文字'], outcomes: ['文字和声音承担不同的信息角色。'] },
      { id: 'seg-creative-sound-prototype', title: '用最小样本检验体验', summary: '将三个片段连接成一个短流程，观察是否能让人理解这种记录方式。', keywords: ['原型', '验证'], outcomes: ['先验证体验，再扩大素材数量。'] },
    ],
  },
  {
    id: 'conv-creative-garden', categoryId: 'cat-creative', title: '一座会生长的数字花园',
    summary: '把笔记看成可以持续补充的种子，探索以关系和回访驱动的内容空间。',
    keywords: ['数字花园', '笔记', '连接', '创意'],
    outcomes: ['记录之间通过主题关系互相连接。', '内容可以逐渐完善，无需一次定稿。'],
    createdAt: '2026-10-13T07:40:00Z', updatedAt: '2026-10-14T02:00:00Z',
    segments: [
      { id: 'seg-creative-garden-seed', title: '允许一个念头先作为种子', summary: '先保存一个足够明确的想法，后续再增加证据、例子和关联。', keywords: ['种子', '想法'], outcomes: ['记录不需要在创建时就完整。'] },
      { id: 'seg-creative-garden-links', title: '让关系成为另一种目录', summary: '用少量有意义的主题连接，帮助人在不同笔记之间发现新的路径。', keywords: ['关系', '目录'], outcomes: ['每条连接都能解释为什么相关。'] },
      { id: 'seg-creative-garden-return', title: '把回访作为生长的节奏', summary: '定期回到旧记录，补充新理解，保留观点变化的痕迹。', keywords: ['回访', '积累'], outcomes: ['旧内容可以被新问题重新激活。'] },
    ],
  },
  {
    id: 'conv-life-walk', categoryId: 'cat-life', title: '散步时遇到的三个念头',
    summary: '把不经意的观察记录下来，让日常路线也能成为想法的来源。',
    keywords: ['散步', '观察', '生活', '灵感'],
    outcomes: ['记录具体场景与当下的问题。', '回访时选择一个念头继续展开。'],
    createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-12T09:00:00Z',
    segments: [
      { id: 'seg-life-walk-slow', title: '为观察留出一点慢速时间', summary: '选择一条熟悉的路线，用较慢的节奏注意平时忽略的变化。', keywords: ['节奏', '观察'], outcomes: ['一次散步记录一个清楚的发现。'] },
      { id: 'seg-life-walk-question', title: '从一个细节生出一个问题', summary: '把眼前的变化转成一个值得追问的问题，延长观察带来的思考。', keywords: ['细节', '问题'], outcomes: ['灵感记录带有可以继续探索的方向。'] },
      { id: 'seg-life-walk-connect', title: '回来后连接到正在做的事', summary: '检查这个念头是否能为写作、设计或项目提供一个小启发。', keywords: ['连接', '项目'], outcomes: ['观察可以迁移到当前工作场景。'] },
    ],
  },
  {
    id: 'conv-life-reading', categoryId: 'cat-life', title: '读完之后，留下什么',
    summary: '用少量自己的话保存一本书带来的变化，让阅读记录可以参与以后的思考。',
    keywords: ['阅读', '笔记', '反思', '生活'],
    outcomes: ['每次阅读只保留最有用的一条理解。', '把书中的观点连接到自己的经历。'],
    createdAt: '2026-10-11T13:00:00Z', updatedAt: '2026-10-13T13:10:00Z',
    segments: [
      { id: 'seg-life-reading-idea', title: '用自己的话留下一条观点', summary: '不急着摘录整段内容，先判断哪条理解真正改变了自己的看法。', keywords: ['观点', '理解'], outcomes: ['笔记能够脱离原文仍然被读懂。'] },
      { id: 'seg-life-reading-example', title: '给观点找一个生活例子', summary: '将抽象观点对应到最近的经历，检查自己是否理解了它的适用范围。', keywords: ['例子', '迁移'], outcomes: ['观点与真实经历形成连接。'] },
      { id: 'seg-life-reading-action', title: '留下一个可以尝试的改变', summary: '选择一个足够小的行动，把阅读收获带回日常生活。', keywords: ['行动', '实践'], outcomes: ['阅读笔记包含一个可执行的下一步。'] },
    ],
  },
  {
    id: 'conv-life-focus', categoryId: 'cat-life', title: '为专注留一块安静的地方',
    summary: '围绕工作开始与结束的两个时刻，建立轻量、可以坚持的专注习惯。',
    keywords: ['专注', '习惯', '效率', '生活'],
    outcomes: ['开始前只确定一个具体目标。', '结束时留下当前状态与下一步。'],
    createdAt: '2026-10-13T09:30:00Z', updatedAt: '2026-10-14T01:40:00Z',
    segments: [
      { id: 'seg-life-focus-start', title: '开始前明确这一段要完成什么', summary: '将模糊的工作意图改写为一个能够判断是否完成的小目标。', keywords: ['目标', '开始'], outcomes: ['一次专注对应一个具体成果。'] },
      { id: 'seg-life-focus-space', title: '减少眼前会分散注意力的事', summary: '整理当前任务需要的窗口与材料，让开始工作的阻力尽可能小。', keywords: ['环境', '注意力'], outcomes: ['任务需要的信息在开始时已经就位。'] },
      { id: 'seg-life-focus-end', title: '结束时为下次留下入口', summary: '记录已经完成的内容与下一步，减少重新进入任务时的记忆负担。', keywords: ['结束', '上下文'], outcomes: ['下一次可以从清楚的起点继续。'] },
    ],
  },
];

const conversations = conversationDefinitions.map(({ segments: children, ...conversation }) => ({
  ...conversation,
  kind: 'conversation',
  segmentCount: children.length,
  messageCount: children.length * 6,
}));

const segments = conversationDefinitions.flatMap((conversation) =>
  conversation.segments.map((segment, index) => {
    const start = index * 6 + 1;
    const end = start + 5;
    return {
      ...segment,
      kind: 'segment',
      categoryId: conversation.categoryId,
      conversationId: conversation.id,
      order: index + 1,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messageCount: end - start + 1,
      messageRange: {
        start: `mock-msg-${conversation.id}-${String(start).padStart(3, '0')}`,
        end: `mock-msg-${conversation.id}-${String(end).padStart(3, '0')}`,
      },
      messageIndexRange: { start, end },
    };
  }),
);

const categories = categoryDefinitions.map((category) => {
  const children = conversations.filter((conversation) => conversation.categoryId === category.id);
  return {
    ...category,
    conversationCount: children.length,
    messageCount: children.reduce((total, conversation) => total + conversation.messageCount, 0),
    createdAt: children.map((conversation) => conversation.createdAt).sort()[0],
    updatedAt: children.map((conversation) => conversation.updatedAt).sort().at(-1),
  };
});

/** @type {{provenance: object, categories: object[], conversations: object[], segments: object[]}} */
export const mockAtlas = {
  provenance: {
    mode: 'mock',
    label: '本地模拟数据 · 视觉交互原型',
    description: '所有内容与消息引用均为虚构示例；尚未接入真实对话、语义搜索或后端服务。',
  },
  categories,
  conversations,
  segments,
};

/** Verbatim Store viewer. Unconnected order groups never imply chronology. */
const make = (tag, className, text) => {
  const node = document.createElement(tag);
  node.className = className || '';
  if (text !== undefined) node.textContent = text;
  return node;
};

export function openMessages(detail, title, messageKey = null) {
  let dialog = document.getElementById('raw-dialog');
  if (!dialog) {
    dialog = make('dialog', 'raw-dialog');
    dialog.id = 'raw-dialog';
    dialog.setAttribute('aria-label', '对话完整原文');
    document.body.append(dialog);
  }
  dialog.replaceChildren();
  const header = make('header', 'raw-header');
  const heading = make('div');
  heading.append(make('span', 'eyebrow', '对话原文'), make('h2', '', title));
  const close = make('button', 'quiet-button', '关闭原文');
  close.addEventListener('click', () => dialog.close());
  header.append(heading, close);
  const ordering = detail.quality?.ordering;
  const orderNote = ordering === 'source_time' ? '按原始消息创建时间排列'
    : ordering === 'dom_relative' ? '按页面消息先后排列'
    : '部分历史顺序未确认；仅同组内已确认的相对顺序可信，组间不代表先后';
  const note = make('p', 'prototype-note', `${detail.messages.length} 条已存储消息 · ${orderNote}。完整历史未知；空正文保留。`);
  const jump = make('select', 'raw-jump');
  jump.setAttribute('aria-label', '选择对话消息');
  const list = make('div', 'raw-message-list');
  const jumpTo = (key) => {
    jump.value = key;
    const target = [...list.children].find((node) => node.dataset.messageKey === key);
    list.querySelector('.raw-message.located')?.classList.remove('located');
    if (target) { target.classList.add('located'); target.scrollIntoView({ block: 'start', behavior: 'instant' }); }
  };
  detail.messages.forEach((message, index) => {
    const role = {user:'用户提问',assistant:'模型回答'}[message.role] || message.role;
    const option = make('option', '', `${String(index + 1).padStart(2, '0')} · ${role}`);
    option.value = message.key;
    jump.append(option);
    const article = make('article', 'raw-message');
    article.dataset.messageKey = message.key;
    article.id = `raw-message-${encodeURIComponent(message.key)}`;
    const meta = make('header');
    const position = message.sourceOrder != null ? `对话顺序 ${message.sourceOrder + 1}`
      : message.relativeOrder != null ? `相对组 ${message.orderGroup + 1} / ${message.relativeOrder + 1} · 组间顺序未知`
      : '历史顺序未确认';
    meta.append(make('strong', '', `${position} · ${role}`));
    article.append(meta, make('pre', '', message.content.trim() ? message.content : '〔Store 中正文为空，无法补全未采集内容〕'));
    list.append(article);
  });
  jump.addEventListener('change', () => jumpTo(jump.value));
  dialog.append(header, note, jump, list);
  if (!detail.messages.length) list.append(make('p', 'empty-search', '此会话尚无已存储消息。'));
  dialog.showModal();
  if (messageKey) jumpTo(messageKey);
  else list.scrollTop = 0;
}

/** Exact Store text, rendered with safe DOM nodes; no model-authored body or HTML execution. */
export function openAnswer(detail, title) {
  let dialog = document.getElementById('raw-dialog');
  if (!dialog) { dialog = make('dialog','raw-dialog'); dialog.id='raw-dialog'; document.body.append(dialog); }
  dialog.replaceChildren(); dialog.setAttribute('aria-label','关键回答完整原文');
  const header=make('header','raw-header');
  const heading=make('div'); heading.append(make('span','eyebrow','原始对话 / 完整回答'),make('h2','',title));
  const close=make('button','quiet-button','关闭原文'); close.addEventListener('click',()=>dialog.close());
  header.append(heading,close); dialog.append(header);
  if(detail.contextStatus!=='ordered_adjacent') dialog.append(make('p','prototype-note','暂无法可靠关联用户提问，以下展示对应模型原文。'));
  const list=make('div','raw-message-list');
  for (const message of [...detail.questions,detail.answer]) {
    const article=make('article','raw-message'); article.dataset.messageKey=message.key;
    article.append(make('h3','',message.role==='user' ? '用户提问' : '模型回答全文'));
    article.append(make('small','',message.source_created_at != null ? `原始创建时间：${new Date(message.source_created_at*1000).toLocaleString('zh-CN')}` : '原始发送时间未采集'));
    const body=make('div','raw-prose');
    const parts=message.content.split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g);
    for(const part of parts) {
      if(part.startsWith('```')) {const pre=make('pre');pre.append(make('code','',part.replace(/^```[^\n]*\n/,'').replace(/```$/,'')));body.append(pre);}
      else body.append(make('div','',part));
    }
    article.append(body); list.append(article);
  }
  dialog.append(list); dialog.showModal(); list.scrollTop=0;
}

/** Verbatim local Store viewer. Display order is observed order, never an AI Segment. */
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
    dialog.setAttribute('aria-label', 'SQLite 原始消息');
    document.body.append(dialog);
  }
  dialog.replaceChildren();
  const header = make('header', 'raw-header');
  const heading = make('div');
  heading.append(make('span', 'eyebrow', 'SQLITE / 原始观察记录'), make('h2', '', title), make('p', 'raw-id', detail.conversationId));
  const close = make('button', 'quiet-button', '关闭原文');
  close.addEventListener('click', () => dialog.close());
  header.append(heading, close);
  const note = make('p', 'prototype-note', `${detail.messages.length} 条已存储消息 · 按首次观察顺序排列，非已验证的原始顺序。完整历史未知；空正文保留，fallback 键可能不稳定。`);
  const jump = make('select', 'raw-jump');
  jump.setAttribute('aria-label', '定位原始消息键');
  const list = make('div', 'raw-message-list');
  const jumpTo = (key) => {
    jump.value = key;
    const target = [...list.children].find((node) => node.dataset.messageKey === key);
    list.querySelector('.raw-message.located')?.classList.remove('located');
    if (target) { target.classList.add('located'); target.scrollIntoView({ block: 'start', behavior: 'instant' }); }
  };
  detail.messages.forEach((message, index) => {
    const option = make('option', '', `${String(index + 1).padStart(2, '0')} · ${message.role} · ${message.key}`);
    option.value = message.key;
    jump.append(option);
    const article = make('article', 'raw-message');
    article.dataset.messageKey = message.key;
    article.id = `raw-message-${encodeURIComponent(message.key)}`;
    const meta = make('header');
    meta.append(make('strong', '', `观察序号 ${index + 1} · ${message.role}`), make('code', '', message.key));
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

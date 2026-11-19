export const indexReason = (code) => ({
  ORDER_UNRELIABLE: '消息顺序尚未确认，请先完成重叠采集',
  IDENTITY_UNRELIABLE: '消息身份尚不可靠，暂不能分析',
  BODY_COMPLETENESS_UNCONFIRMED: '存在疑似折叠正文，需先补齐采集',
  SOURCE_REVIEW_REQUIRED: '发现历史补录或正文变化，需要复核，未自动重建',
  INCOMPLETE_TURN: '末尾提问尚无完整回答，等待采集完成',
  TURN_TOO_LARGE: '单轮讨论超过当前模型或本次任务容量，原文未截断',
  CONTEXT_TOO_LARGE: '尾部参考摘要超出预算，需复核',
  MESSAGE_TOO_LARGE: '单条原文超过当前模型或本次任务容量，原文未截断',
  BUDGET_EXHAUSTED: '达到本次预算，已保留成功进度；可再次手动分析',
  TASK_BUSY: '另一个对话正在分析，请等待完成',
  OUTPUT_INVALID: '模型输出未通过校验，原有索引已保留',
  INCOMPLETE_RESPONSE: '模型未返回完整结果，已保留原有索引，可重试',
  OUTPUT_TRUNCATED: '模型输出达到上限，未提交不完整结果；可重试较小批次',
  OPEN_COOLDOWN: '刚执行过自动分析，请稍后再打开；也可选择对话手动继续',
  TOPIC_TOO_LARGE: '当前主题超出模型完整输入容量，原文未截断',
  CONCEPT_COVERAGE_INVALID: '概念分块未完整覆盖本主题来源',
  INDEX_CHANGED: '主题索引已更新，请重新核对',
  SEGMENT_NOT_FOUND: '该主题已不存在',
  CONFIG_MISSING: '请先在本机私有配置中设置 DeepSeek 密钥',
  AUTH_FAILED: '模型密钥未通过验证', INSUFFICIENT_BALANCE: '模型账户余额不足',
  REQUEST_TIMEOUT: '模型请求超时，未完成范围仍待分析', MODEL_UNAVAILABLE: '暂时无法连接模型服务',
  SOURCE_CHANGED: '分析期间原文变化，未提交过期结果',
}[code] || (code?.startsWith('OUTPUT_INVALID:') ? '模型结构校验未通过，已有索引保留，可重试' : code ? `暂未完成：${code}` : ''));

export async function indexRequest(path, method = 'GET', fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(path, {method, cache:'no-store',
    headers:method === 'POST' ? {'x-atlas-action':'manual-analysis'} : {},
    signal:AbortSignal.timeout(15000)});
  const value = await response.json();
  if (!response.ok) throw new Error(indexReason(value.detail?.code) || value.detail || `服务返回 HTTP ${response.status}`);
  return value;
}

export class OpenAnalysisControls {
  constructor({status,onUpdate,fetchImpl=globalThis.fetch}) {
    Object.assign(this,{status,onUpdate,fetchImpl});
    this.started=false; this.active=false; this.busy=false; this.signature=null;
  }
  async read(method) {
    const response=await this.fetchImpl('/api/atlas/auto-index',{method,cache:'no-store',
      headers:method==='POST'?{'x-atlas-action':'open-analysis'}:{},signal:AbortSignal.timeout(15000)});
    const task=await response.json();
    if (!response.ok) throw new Error(indexReason(task.detail?.code)||'自动分析状态暂不可用');
    this.active=['queued','running'].includes(task.status);
    const signature=JSON.stringify(task);
    if(this.signature && signature!==this.signature) this.onUpdate();
    this.signature=signature;
    this.status.textContent=this.active?'正在自动检查并分析新增内容…':
      task.status==='failed'?`自动分析未完成：${indexReason(task.errorCode)}`:
      task.status==='paused'?`本次自动分析已暂停 · ${indexReason(task.errorCode)}`:
      task.skipped?`自动检查完成 · ${task.skipped} 项待复核或重试`:
      task.requests?`自动分析完成 · ${task.requests} 次请求`:'已自动检查 · 没有可分析的新增内容';
    return task;
  }
  async open() {
    if(this.started) return;
    this.started=true;
    try {await this.read('POST');} catch(error) {this.status.textContent=error.message;}
  }
  async refresh() {
    if(!this.active || this.busy) return;
    this.busy=true;
    try {await this.read('GET');} catch(error) {this.status.textContent=error.message;}
    finally {this.busy=false;}
  }
}

export class IndexControls {
  constructor({button, scope, status, onUpdate, fetchImpl}) {
    Object.assign(this, {button, scope, status, onUpdate, fetchImpl});
    this.generation = 0; this.cid = null; this.busy = false;
    button.addEventListener('click', () => this.start());
  }
  select(cid, title) {
    if (cid === this.cid) { this.scope.textContent = title ? `当前对话：${title}` : '选择一个对话后可分析新增内容'; return; }
    this.cid = cid; this.generation++; this.signature = null; this.busy = false; this.actionError = '';
    this.button.disabled = true;
    this.scope.textContent = title ? `当前对话：${title}` : '选择一个对话后可分析新增内容';
    this.status.textContent = cid ? '正在核对已索引范围…' : '';
    if (cid) this.refresh();
  }
  async refresh() {
    const cid = this.cid, generation = this.generation;
    if (!cid || this.busy) return;
    try {
      const value = await indexRequest(`/api/atlas/index-state/${encodeURIComponent(cid)}`, 'GET', this.fetchImpl);
      if (generation !== this.generation || this.busy) return;
      const {source,task} = value;
      const running = ['queued','running'].includes(task?.status);
      const pending = source.appended.length;
      this.button.disabled = running || source.status !== 'ready' || !pending;
      this.button.textContent = running ? '正在分析…' : '分析新增内容';
      this.status.textContent = `已索引 ${source.unchanged.length} 条 · 待分析 ${pending} 条` +
        (source.status !== 'ready' ? ` · ${indexReason(source.reason)}` : running ? ' · 后台处理中' :
          task?.error_code ? ` · ${indexReason(task.error_code)}` : this.actionError ? ` · ${this.actionError}` : !pending ? ' · 已是最新状态' : '');
      const signature = JSON.stringify([source,task?.run_id,task?.status,task?.committed_batches]);
      if (this.signature && signature !== this.signature) this.onUpdate();
      this.signature = signature;
    } catch (error) {
      if (generation !== this.generation) return;
      this.status.textContent = `状态读取失败：${error.message}`; this.button.disabled = true;
    }
  }
  async start() {
    if (!this.cid || this.busy || this.button.disabled) return;
    const cid = this.cid, generation = this.generation;
    this.busy = true; this.actionError = ''; this.button.disabled = true; this.status.textContent = '正在为当前对话准备有界分析…';
    try {
      await indexRequest(`/api/atlas/index/${encodeURIComponent(cid)}`, 'POST', this.fetchImpl);
    } catch (error) {
      if (generation === this.generation) { this.actionError = error.message; this.status.textContent = error.message; }
    } finally {
      if (generation === this.generation) this.busy = false;
    }
    if (generation === this.generation) { await this.refresh(); this.onUpdate(); }
  }
}

/** One in-flight tick; hidden pages make no polling requests. */
export class VisiblePoller {
  constructor(tick, {document: page = globalThis.document, interval = 4000,
    setTimer = (...args) => globalThis.setTimeout(...args),
    clearTimer = (...args) => globalThis.clearTimeout(...args)} = {}) {
    Object.assign(this, {tick, page, interval, setTimer, clearTimer});
    this.running = false; this.inFlight = false; this.timer = null;
    this.visibility = () => {
      this.clearTimer(this.timer); this.timer = null;
      if (!this.page.hidden) this.run();
    };
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.page.addEventListener('visibilitychange', this.visibility);
    this.schedule();
  }
  schedule() {
    if (this.running && !this.page.hidden)
      this.timer = this.setTimer(() => { this.timer = null; this.run(); }, this.interval);
  }
  async run() {
    if (!this.running || this.page.hidden || this.inFlight) return;
    this.inFlight = true;
    try { await this.tick(); }
    finally { this.inFlight = false; this.schedule(); }
  }
  stop() {
    this.running = false;
    this.clearTimer(this.timer); this.timer = null;
    this.page.removeEventListener('visibilitychange', this.visibility);
  }
}

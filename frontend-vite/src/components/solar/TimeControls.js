export class TimeControls {
  constructor(container, onRate) {
    this.element = document.createElement('nav');
    this.element.className = 'time-control-panel';
    this.element.setAttribute('aria-label', '星历时间控制器');
    this.element.style.cssText = 'position:absolute;left:12px;top:12px;z-index:20;max-width:calc(100% - 24px);padding:8px;background:rgba(5,12,25,.9);color:#fff;font:12px/1.5 sans-serif;pointer-events:auto;border-radius:6px;';
    this.time = document.createElement('time');
    this.mode = document.createElement('span');
    this.status = document.createElement('div');
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.source = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '数据来源 / 中心 / 时间假设';
    this.source.appendChild(summary);
    const provenance = document.createElement('div');
    provenance.textContent = 'JPL DE440 · ECLIPJ2000 AU · Mercury 199/Venus 299/Earth 399 body_center 日心10；Mars–Neptune 4–8/10 system_barycenter（非499–899）；Moon 301/399 地心；Sun 日心原点；Halley Horizons JPL#75 / DE441 日心10。TDB: naif0012.tls，2017后ΔAT=37s外推，不预测未来闰秒；系统UTC正确为前提。仅位置/公转，自转示意未验证。';
    this.source.appendChild(provenance);
    const toolbar = document.createElement('div');
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', '推进速率');
    this.buttons = [1, 60, 3600, 86400].map((rate) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.rate = String(rate);
      button.textContent = `${rate}x`;
      button.addEventListener('click', () => onRate(rate));
      toolbar.appendChild(button);
      return button;
    });
    const now = document.createElement('button');
    now.type = 'button';
    now.dataset.action = 'return-realtime';
    now.textContent = '回到现实';
    now.addEventListener('click', () => onRate(1));
    toolbar.appendChild(now);
    this.element.append(this.time, this.mode, toolbar, this.status, this.source);
    this.stopEvent = (event) => event.stopPropagation();
    for (const event of ['pointerdown', 'pointerup', 'click', 'dblclick', 'wheel', 'touchstart', 'touchmove', 'touchend']) {
      this.element.addEventListener(event, this.stopEvent);
    }
    container.appendChild(this.element);
  }

  update(sample, status) {
    const iso = new Date(sample.utcMs).toISOString();
    this.time.dateTime = iso;
    this.time.textContent = sample.rate === 1 ? `${iso} UTC ` : `${sample.jdTdb.toFixed(9)} JD TDB (LSK extrapolated) `;
    this.mode.dataset.mode = sample.mode;
    this.mode.textContent = sample.rate === 1 ? '实时 1x' : `手动模拟 ${sample.rate}x`;
    for (const button of this.buttons) button.setAttribute('aria-pressed', String(Number(button.dataset.rate) === sample.rate));
    const applied = status.lastAppliedJd === null ? 'none' : `${status.lastAppliedJd.toFixed(9)} JD TDB / ${new Date(status.lastAppliedUtcMs).toISOString()} (LSK assumed)`;
    const text = `${status.status === 'ready' ? 'READY' : status.status === 'error' ? 'EPHEMERIS_ERROR' : 'SYNCHRONIZING / EPHEMERIS_INITIALIZING'} · actual applied epoch: ${applied}${status.error ? ` · ${status.error}` : ''}`;
    if (this.status.textContent !== text) this.status.textContent = text;
    this.element.dataset.status = status.status;
    this.element.dataset.appliedJd = status.lastAppliedJd ?? '';
  }

  dispose() {
    this.element.remove();
  }
}

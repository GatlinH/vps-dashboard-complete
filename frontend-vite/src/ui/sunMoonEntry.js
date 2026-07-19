import '../globals/dashboardGlobals.js';
export function renderSunBadge() {
  const mount = document.getElementById('globeSunMount');
  if (!mount) return;
  mount.innerHTML = `
    <button class="three-globe-sun-badge" id="globeSunBadge" type="button" aria-label="拖动太阳进入登录界面">
      <span class="three-globe-sun-glow"></span>
      <span class="three-globe-sun-corona"></span>
      <span class="three-globe-sun-halo"></span>
      <span class="three-globe-sun-core"></span>
    </button>`;
  const badge = document.getElementById('globeSunBadge');
  if (!badge) return;
  let dragging = false;
  let armed = false;
  let pointerId = null;
  let startX = 0;
  let startY = 0;

  const onMove = (e) => {
    if (!dragging) return;
    if (pointerId != null && e.pointerId != null && e.pointerId != pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const dist = Math.hypot(dx, dy);
    const progress = Math.max(0, Math.min(1, dist / 80));
    badge.style.setProperty('--sun-drag-progress', String(progress));
    badge.style.transform = `translate(${dx}px, ${dy}px)`;
    armed = dist >= 46;
    badge.classList.toggle('is-complete', armed);
  };

  const reset = () => {
    dragging = false;
    armed = false;
    pointerId = null;
    badge.classList.remove('is-dragging', 'is-complete');
    badge.style.removeProperty('--sun-drag-progress');
    badge.style.removeProperty('transform');
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', finish, true);
    document.removeEventListener('pointercancel', reset, true);
  };

  const finish = () => {
    const go = armed;
    reset();
    if (go) window.setTimeout(() => {
      if (typeof window.openFrontLogin === 'function') window.openFrontLogin();
      else window.location.href = '/?login=1';
    }, 60);
  };

  badge.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dragging = true;
    armed = false;
    pointerId = e.pointerId ?? null;
    startX = e.clientX;
    startY = e.clientY;
    badge.classList.add('is-dragging');
    badge.setPointerCapture?.(e.pointerId);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', finish, true);
    document.addEventListener('pointercancel', reset, true);
  });
  badge.addEventListener('click', (e) => {
    if (dragging || armed) return;
    // click alone previews nothing; sun entrance intentionally requires drag/keyboard
  });
  badge.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (typeof window.openFrontLogin === 'function') window.openFrontLogin();
      else window.location.href = '/?login=1';
    }
  });
  window.__DBG__.testDragSunLogin = () => { window.location.href = '/?login=1'; };
  window.__DBG__.testDragMoonOverview = () => { window.location.href = '/?overview=1'; };
}

export function renderMoonPanel() {
  const panel = document.getElementById('globeMoonPanel');
  if (!panel) return;
  const root = document.getElementById('globeMoonRoot');
  root?.classList.remove('open');
  panel.innerHTML = `
    <button class="globe-moon-pill moon-drag-only moon-solar-style" id="globeMoonToggle" type="button" aria-label="拖动月亮进入资产总览">
      <span class="moon-solar-glow" aria-hidden="true"></span>
      <span class="moon-solar-corona" aria-hidden="true"></span>
      <span class="moon-solar-halo" aria-hidden="true"></span>
      <span class="moon-solar-core" aria-hidden="true"></span>
    </button>`;
  const toggle = document.getElementById('globeMoonToggle');
  if (!toggle) return;
  let dragging = false;
  let armed = false;
  let pointerId = null;
  let startX = 0;
  let startY = 0;

  const onMove = (e) => {
    if (!dragging) return;
    if (pointerId != null && e.pointerId != null && e.pointerId != pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const progress = Math.min(1, Math.hypot(dx, dy) / 90);
    toggle.style.setProperty('--moon-drag-progress', progress.toFixed(3));
    toggle.style.transform = `translate(${dx}px, ${dy}px)`;
    armed = (dx <= -32 && dy <= -14) || Math.hypot(dx, dy) >= 58;
    toggle.classList.toggle('is-complete', armed);
  };

  const reset = () => {
    dragging = false;
    armed = false;
    pointerId = null;
    toggle.classList.remove('is-dragging', 'is-complete');
    toggle.style.removeProperty('transform');
    toggle.style.removeProperty('--moon-drag-progress');
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', finish, true);
    document.removeEventListener('pointercancel', reset, true);
  };

  const finish = () => {
    const go = armed;
    reset();
    if (go) window.setTimeout(() => window.openMoonOverview?.(), 60);
  };

  toggle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dragging = true;
    armed = false;
    pointerId = e.pointerId ?? null;
    startX = e.clientX;
    startY = e.clientY;
    toggle.classList.add('is-dragging');
    toggle.setPointerCapture?.(e.pointerId);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', finish, true);
    document.addEventListener('pointercancel', reset, true);
  });
  toggle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      window.openMoonOverview?.();
    }
  });
}
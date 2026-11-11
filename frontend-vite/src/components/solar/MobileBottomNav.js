import { t } from '../../core/preferences.js';

function validServerId(value) {
  if (typeof value === 'string') {
    if (!/^[1-9][0-9]*$/.test(value)) return null;
    value = Number(value);
  }
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function createMobileBottomNav({ container, solarHost, navigate, getSnapshot, isVisible, switchGlobe }) {
  let alive = true;
  let inFlight = false;
  let hintKey = null;
  const previousAttribute = solarHost.getAttribute('data-solar-mobile-nav');
  const disposers = [];
  const nav = document.createElement('nav');
  nav.setAttribute('class', 'mobile-bottom-nav');
  const status = document.createElement('aside');
  status.setAttribute('class', 'mobile-bottom-nav-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;
  const keys = ['mobileNavAdmin', 'mobileNavAssets', 'mobileNavDetails', 'mobileNavEarth'];
  const icons = [
    '<rect x="4" y="9" width="16" height="11" rx="2"/><path d="M8 9V6a4 4 0 0 1 8 0v3M12 13v3"/>',
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    '<path d="M7 3h7l4 4v14H7zM14 3v5h4M10 12h5M10 16h5"/>',
    '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 7h14M5 17h14"/>',
  ];
  function listen(target, name, handler) {
    target.addEventListener(name, handler);
    disposers.push(() => target.removeEventListener(name, handler));
  }
  function clearHint() {
    hintKey = null;
    status.hidden = true;
    status.textContent = '';
  }
  function showHint(key) {
    hintKey = key;
    status.textContent = t(key);
    status.hidden = false;
  }
  function goTo(url) {
    navigate(url);
    clearHint();
  }
  function openDetails() {
    const snapshot = getSnapshot();
    if (snapshot.serversSource !== '后台接口 /api/v1/servers + IP 坐标定位') {
      showHint('mobileNavLoading');
      return;
    }
    const servers = Array.isArray(snapshot.servers) ? snapshot.servers : [];
    if (!servers.length) {
      showHint('mobileNavEmpty');
      return;
    }
    const routeProvided = snapshot.routeServerId !== undefined && snapshot.routeServerId !== null;
    const routeId = validServerId(snapshot.routeServerId);
    if (routeProvided && routeId === null) {
      showHint('mobileNavSelect');
      return;
    }
    const ids = servers.map((server) => validServerId(server?.id));
    const target = routeId !== null && ids.includes(routeId) ? routeId : servers.length === 1 ? ids[0] : null;
    if (target === null) {
      showHint('mobileNavSelect');
      return;
    }
    goTo(`/?server=${target}`);
  }
  async function openEarth() {
    if (!alive || inFlight || isVisible()) return;
    inFlight = true;
    try {
      const result = await switchGlobe();
      if (alive && result !== null && result !== false && isVisible()) {
        clearHint();
        syncView();
      }
    } catch {
      return;
    } finally {
      if (alive) inFlight = false;
    }
  }
  const actions = [() => goTo('/admin.html'), () => goTo('/?overview=1'), openDetails, openEarth];
  const buttons = keys.map((key, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('type', 'button');
    button.setAttribute('aria-pressed', 'false');
    const icon = document.createElement('span');
    icon.setAttribute('class', 'mobile-bottom-nav-icon');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[index]}</svg>`;
    const label = document.createElement('span');
    button.append(icon, label);
    listen(button, 'click', () => { if (alive) actions[index](); });
    nav.appendChild(button);
    return button;
  });
  function updateLanguage() {
    buttons.forEach((button, index) => {
      button.children[1].textContent = t(keys[index]);
      button.setAttribute('aria-label', t(keys[index]));
    });
    if (hintKey) status.textContent = t(hintKey);
  }
  function syncView() {
    if (!alive) return;
    buttons[3].setAttribute('aria-pressed', String(Boolean(isVisible())));
  }
  for (const name of ['pointerdown', 'pointerup', 'click', 'dblclick']) {
    listen(nav, name, (event) => event.stopPropagation());
  }
  listen(window, 'vps-language-changed', updateLanguage);
  solarHost.setAttribute('data-solar-mobile-nav', 'true');
  container.append(nav, status);
  updateLanguage();
  syncView();
  return {
    syncView,
    destroy() {
      if (!alive) return;
      alive = false;
      disposers.forEach((dispose) => dispose());
      nav.remove();
      status.remove();
      if (previousAttribute === null) solarHost.removeAttribute('data-solar-mobile-nav');
      else solarHost.setAttribute('data-solar-mobile-nav', previousAttribute);
    },
  };
}

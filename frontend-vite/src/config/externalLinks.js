import '../globals/dashboardGlobals.js';
export function getRuntimeExternalLinks() {
  if (typeof window === 'undefined') return {};
  return window.__DBG__.DASHBOARD_EXTERNAL_LINKS && typeof window.__DBG__.DASHBOARD_EXTERNAL_LINKS === 'object'
    ? window.__DBG__.DASHBOARD_EXTERNAL_LINKS
    : {};
}

export function sameHostHttpUrl(port, pathname = '') {
  if (typeof window === 'undefined') return '';
  const host = window.location?.hostname || '127.0.0.1';
  const path = pathname ? `/${String(pathname).replace(/^\/+/, '')}` : '';
  return `http://${host}:${port}${path}`;
}

export function getKomariPanelUrl() {
  const runtime = getRuntimeExternalLinks();
  const envUrl = import.meta?.env?.VITE_KOMARI_PANEL_URL;
  return runtime.komariPanelUrl || envUrl || sameHostHttpUrl(25774);
}

import '../globals/dashboardGlobals.js';
export function getDashboardDebug(section = null) {
  window.__DBG__.DASHBOARD_DEBUG = window.__DBG__.DASHBOARD_DEBUG || {};
  if (!section) return window.__DBG__.DASHBOARD_DEBUG;
  window.__DBG__.DASHBOARD_DEBUG[section] = window.__DBG__.DASHBOARD_DEBUG[section] || {};
  return window.__DBG__.DASHBOARD_DEBUG[section];
}

export function getGlobeDebug() {
  return getDashboardDebug('globe');
}

export function getGlobeRuntimeDebug() {
  const globe = getGlobeDebug();
  globe.runtime = globe.runtime || {};
  return globe.runtime;
}

export function getGlobeResourceDebug() {
  const globe = getGlobeDebug();
  globe.resources = globe.resources || {};
  return globe.resources;
}

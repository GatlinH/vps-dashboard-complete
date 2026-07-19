// Single namespace for all dashboard debug/state globals.
// Previously ~37 separate legacy window debug globals variables; now consolidated here.
export const G = window.__DBG__ = window.__DBG__ || {};

// Preserve externally-set globals (set before this script loads)
if (window['__API_ROOT__'] && !G.API_ROOT) {
  G.API_ROOT = window['__API_ROOT__'];
  delete window['__API_ROOT__'];
}

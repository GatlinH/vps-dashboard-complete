import { SettingsPanel } from '../components/admin/SettingsPanel.js';

export function createSettingsPanel(mountId) {
  return new SettingsPanel(mountId);
}

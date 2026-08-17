import { ServerManager } from '../components/admin/ServerManager.js';

export function createServerForm(mountId) {
  return new ServerManager(mountId);
}

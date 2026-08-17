export function bindDisplayEventHandlers({
  serversChannel,
  selectedServerId,
  refreshDisplayServers,
  refreshDetailRealtime,
}) {
  const onStorage = async (event) => {
    if (event.key === 'vps-servers-version') await refreshDisplayServers();
  };
  const onVisibilityChange = () => {
    if (!document.hidden) {
      selectedServerId ? refreshDetailRealtime(selectedServerId) : refreshDisplayServers();
    }
  };

  window.addEventListener('storage', onStorage);
  window.addEventListener('servers-changed', refreshDisplayServers);
  window.addEventListener('pageshow', refreshDisplayServers);
  document.addEventListener('visibilitychange', onVisibilityChange);
  serversChannel?.addEventListener('message', refreshDisplayServers);

  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('servers-changed', refreshDisplayServers);
    window.removeEventListener('pageshow', refreshDisplayServers);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    serversChannel?.removeEventListener('message', refreshDisplayServers);
  };
}

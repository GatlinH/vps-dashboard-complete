export function createDetailChartInitializer({
  renderCharts,
  detailCharts,
  helpers,
  getPingSampleCache,
}) {
  return function renderDetailMonitorCharts(args) {
    return renderCharts(args, {
      detailCharts,
      ...helpers,
      getDetailPingSampleCache: getPingSampleCache,
    });
  };
}

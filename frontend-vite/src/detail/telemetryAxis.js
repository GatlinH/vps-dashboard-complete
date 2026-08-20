export function coldStartAxisBounds(xs = [], fullSpanMs, nowMs = Date.now()) {
  const fullSpan = Math.max(1, Number(fullSpanMs) || 1);
  const times = (Array.isArray(xs) ? xs : [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!times.length) {
    return {
      min: nowMs - fullSpan,
      max: nowMs,
      step: fullSpan / 4,
      mode: 'fixed-window-ending-now',
      spanMs: fullSpan,
    };
  }

  const dataFirst = times[0];
  const dataLast = times[times.length - 1];
  const rolling = dataLast >= dataFirst + fullSpan;
  return {
    min: rolling ? dataLast - fullSpan : dataFirst,
    max: rolling ? dataLast : dataFirst + fullSpan,
    step: fullSpan / 4,
    mode: rolling ? 'rolling-after-full-window' : 'accumulating-from-first-sample',
    spanMs: fullSpan,
  };
}

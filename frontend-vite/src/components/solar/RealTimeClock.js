const DAY_MS = 86400000;
const J2000_MS = Date.UTC(2000, 0, 1, 12);
const LEAPS = [
  ['1972-01-01', 10], ['1972-07-01', 11], ['1973-01-01', 12],
  ['1974-01-01', 13], ['1975-01-01', 14], ['1976-01-01', 15],
  ['1977-01-01', 16], ['1978-01-01', 17], ['1979-01-01', 18],
  ['1980-01-01', 19], ['1981-07-01', 20], ['1982-07-01', 21],
  ['1983-07-01', 22], ['1985-07-01', 23], ['1988-01-01', 24],
  ['1990-01-01', 25], ['1991-01-01', 26], ['1992-07-01', 27],
  ['1993-07-01', 28], ['1994-07-01', 29], ['1996-01-01', 30],
  ['1997-07-01', 31], ['1999-01-01', 32], ['2006-01-01', 33],
  ['2009-01-01', 34], ['2012-07-01', 35], ['2015-07-01', 36],
  ['2017-01-01', 37],
].map(([date, delta]) => [Date.parse(`${date}T00:00:00Z`), delta]);

export function utcToTdb(utcMs) {
  if (!Number.isFinite(utcMs)) throw new Error('invalid UTC milliseconds');
  let deltaAT = 9;
  for (const [start, delta] of LEAPS) {
    if (utcMs < start) break;
    deltaAT = delta;
  }
  const tt = (utcMs - J2000_MS) / 1000 + deltaAT + 32.184;
  let et = tt;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const mean = 6.239996 + 1.99096871e-7 * et;
    et = tt + 0.001657 * Math.sin(mean + 0.01671 * Math.sin(mean));
  }
  return 2451545 + et / (DAY_MS / 1000);
}

export class RealTimeClock {
  constructor({ wallNow = () => Date.now(), monotonicNow = () => performance.now() } = {}) {
    this.wallNow = wallNow;
    this.monotonicNow = monotonicNow;
    this.rate = 1;
    this.anchorSim = this.wallNow();
    this.anchorPerf = this.monotonicNow();
  }

  sample() {
    const utcMs = this.rate === 1
      ? this.wallNow()
      : this.anchorSim + (this.monotonicNow() - this.anchorPerf) * this.rate;
    return {
      utcMs, jdTdb: utcToTdb(utcMs), rate: this.rate,
      mode: this.rate === 1 ? 'realtime' : 'simulation',
      timeScale: 'TDB',
      assumption: 'naif0012.tls; TDB (LSK extrapolated, ΔAT=37s after 2017); system UTC assumed correct',
    };
  }

  setRate(rate) {
    if (![1, 60, 3600, 86400].includes(rate)) throw new Error('unsupported time rate');
    const perf = this.monotonicNow();
    const current = this.rate === 1 ? this.wallNow() : this.anchorSim + (perf - this.anchorPerf) * this.rate;
    this.anchorSim = rate === 1 ? this.wallNow() : current;
    this.anchorPerf = perf;
    this.rate = rate;
    return this.sample();
  }
}

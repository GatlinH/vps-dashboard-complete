// The same small canvas used by the external 320x700 viewport measurement.
export const smallCanvas = Object.freeze({ width: 320, height: 180 });

export function boundaryCases(canvas = smallCanvas, blocked = false) {
  const { width, height } = canvas;
  const edge = blocked
    ? { sun: { x: 45, y: 90 }, earth: { x: 12, y: 90 }, moon: { x: 13.6, y: 90 } }
    : { sun: { x: 45, y: 90 }, earth: { x: 21.5, y: 90 }, moon: { x: 25.5, y: 90 } };
  const corner = blocked
    ? {
        sun: { x: 35, y: 35 },
        earth: { x: 12, y: 12 },
        moon: { x: 12 + 1.6 / Math.SQRT2, y: 12 + 1.6 / Math.SQRT2 },
      }
    : {
        sun: { x: 35, y: 35 },
        earth: { x: 20 - 2 / Math.SQRT2, y: 20 - 2 / Math.SQRT2 },
        moon: { x: 20 + 2 / Math.SQRT2, y: 20 + 2 / Math.SQRT2 },
      };
  const map = (points, transform) =>
    Object.fromEntries(Object.entries(points).map(([name, point]) => [name, transform(point)]));
  return [
    ['left', map(edge, ({ x }) => ({ x, y: height / 2 }))],
    ['right', map(edge, ({ x }) => ({ x: width - x, y: height / 2 }))],
    ['top', map(edge, ({ x }) => ({ x: width / 2, y: x }))],
    ['bottom', map(edge, ({ x }) => ({ x: width / 2, y: height - x }))],
    ['top-left', corner],
    ['top-right', map(corner, ({ x, y }) => ({ x: width - x, y }))],
    ['bottom-left', map(corner, ({ x, y }) => ({ x, y: height - y }))],
    ['bottom-right', map(corner, ({ x, y }) => ({ x: width - x, y: height - y }))],
  ].map(([edge, probes]) => ({ edge, probes, canvas }));
}

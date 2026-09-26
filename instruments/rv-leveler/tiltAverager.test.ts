import { createTiltAverager } from './tiltAverager';

describe('createTiltAverager', () => {
  it('promedia solo las últimas lecturas de la ventana', () => {
    const tiltAverager = createTiltAverager(2);
    tiltAverager.push({ tiltXDegrees: 10, tiltYDegrees: 0 });
    tiltAverager.push({ tiltXDegrees: 1, tiltYDegrees: 2 });
    const averagedTilt = tiltAverager.push({ tiltXDegrees: 3, tiltYDegrees: 4 });
    expect(averagedTilt.meanTilt).toEqual({ tiltXDegrees: 2, tiltYDegrees: 3 });
    expect(averagedTilt.sampleCount).toBe(2);
  });

  it('mide la dispersión en el eje que más varía', () => {
    const tiltAverager = createTiltAverager(10);
    tiltAverager.push({ tiltXDegrees: 0, tiltYDegrees: 0 });
    tiltAverager.push({ tiltXDegrees: 0.1, tiltYDegrees: -0.5 });
    expect(tiltAverager.push({ tiltXDegrees: 0.2, tiltYDegrees: 0.3 }).spreadDegrees).toBeCloseTo(0.8, 10);
  });

  it('reset vacía la ventana', () => {
    const tiltAverager = createTiltAverager(5);
    tiltAverager.push({ tiltXDegrees: 5, tiltYDegrees: 5 });
    tiltAverager.reset();
    expect(tiltAverager.push({ tiltXDegrees: 1, tiltYDegrees: 1 })).toEqual({
      meanTilt: { tiltXDegrees: 1, tiltYDegrees: 1 },
      spreadDegrees: 0,
      sampleCount: 1,
    });
  });

  it('rechaza ventanas no válidas', () => {
    expect(() => createTiltAverager(0)).toThrow();
    expect(() => createTiltAverager(1.5)).toThrow();
  });
});

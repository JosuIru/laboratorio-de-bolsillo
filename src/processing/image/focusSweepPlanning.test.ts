import {
  approximateFocusDistanceCentimeters,
  type FocusProbeMeasurement,
  focusProbePositions,
  measureTileFocusScores,
  planFocusSweepForRange,
  planFocusSweepFromProbe,
} from './focusSweepPlanning';
import { createSeededRandom } from './grayImage';

/** Puntuación de una casilla enfocada en `bestPosition` (campana en la posición). */
function tileScore(lensPosition: number, bestPosition: number): number {
  return 1 + 20 * Math.exp(-((lensPosition - bestPosition) ** 2) / (2 * 0.08 ** 2));
}

describe('focusSweepPlanning', () => {
  it('barre del plano más cercano al más lejano con margen, ignorando las casillas lisas', () => {
    const measurements: FocusProbeMeasurement[] = focusProbePositions.map((lensPosition) => ({
      lensPosition,
      // Dos casillas con objeto (a 0,2 y a 0,4) y una lisa.
      tileScores: [tileScore(lensPosition, 0.2), tileScore(lensPosition, 0.4), 1],
    }));
    const plan = planFocusSweepFromProbe(measurements);
    expect(plan.isFallback).toBe(false);
    expect(plan.usedTileCount).toBe(2);
    expect(plan.nearPosition).toBeGreaterThan(0.1);
    expect(plan.nearPosition).toBeLessThan(0.2);
    expect(plan.farPosition).toBeGreaterThan(0.4);
    expect(plan.farPosition).toBeLessThan(0.5);
    expect(plan.positions.length).toBeGreaterThanOrEqual(8);
    expect(plan.positions.length).toBeLessThanOrEqual(15);
    expect(plan.hasFocusGaps).toBe(false);
    expect(plan.positions[0]).toBeCloseTo(plan.nearPosition, 6);
  });

  it('sin textura usa el rango de reserva', () => {
    const measurements = focusProbePositions.map((lensPosition) => ({ lensPosition, tileScores: [1, 1] }));
    const plan = planFocusSweepFromProbe(measurements);
    expect(plan.isFallback).toBe(true);
    expect(plan.nearPosition).toBe(0);
  });

  it('limita el número de fotos y avisa de los huecos en rangos largos', () => {
    const plan = planFocusSweepForRange({ nearPosition: 0, farPosition: 1 });
    expect(plan.positions).toHaveLength(15);
    expect(plan.hasFocusGaps).toBe(true);
    const shortPlan = planFocusSweepForRange({ nearPosition: 0.3, farPosition: 0.32 });
    expect(shortPlan.positions).toHaveLength(5);
  });

  it('una casilla con detalle puntúa más que una lisa', () => {
    const size = 64;
    const randomValue = createSeededRandom(3);
    const rgbPixels = new Uint8Array(size * size * 3);
    for (let rowIndex = 0; rowIndex < size; rowIndex++) {
      for (let columnIndex = 0; columnIndex < size; columnIndex++) {
        const value = columnIndex < size / 2 - 3 ? 60 + 140 * randomValue() : 128;
        rgbPixels.fill(value, (rowIndex * size + columnIndex) * 3, (rowIndex * size + columnIndex) * 3 + 3);
      }
    }
    const [texturedScore, flatScore] = measureTileFocusScores(rgbPixels, size, size, 2);
    expect(texturedScore!).toBeGreaterThan(100 * Math.max(flatScore!, 1e-9));
  });

  it('pasa la posición a una distancia aproximada', () => {
    expect(approximateFocusDistanceCentimeters(0)).toBeCloseTo(10, 6);
    expect(approximateFocusDistanceCentimeters(0.5)).toBeCloseTo(20, 6);
    expect(approximateFocusDistanceCentimeters(1)).toBe(Number.POSITIVE_INFINITY);
  });
});

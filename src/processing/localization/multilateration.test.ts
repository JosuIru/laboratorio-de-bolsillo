import { createSeededRandom } from '@/processing/dsp/signalGenerator';

import {
  distanceBetween,
  errorEllipseFromCovariance,
  type PlanePoint,
  pseudorangesFromIntervals,
  sampleHyperbolaBranch,
  simulateIntervals,
  solveTdoaPosition,
} from './multilateration';

const speedOfSound = 343.4;
const triangleReceivers: PlanePoint[] = [
  { x: 0, y: 0 },
  { x: 2, y: 0 },
  { x: 1, y: Math.sqrt(3) },
];
const squareReceivers: PlanePoint[] = [
  { x: 0, y: 0 },
  { x: 2, y: 0 },
  { x: 2, y: 2 },
  { x: 0, y: 2 },
];

function pseudorangesFor(sourcePosition: PlanePoint, receiverPositions: PlanePoint[], emitterPosition: PlanePoint) {
  const intervals = simulateIntervals(sourcePosition, receiverPositions, emitterPosition, speedOfSound, 1.2345);
  return pseudorangesFromIntervals(intervals, receiverPositions, emitterPosition, speedOfSound);
}

describe('pseudorrangos', () => {
  it('son la distancia a la fuente más un sesgo común', () => {
    const sourcePosition = { x: 1.3, y: 0.4 };
    const pseudoranges = pseudorangesFor(sourcePosition, squareReceivers, squareReceivers[0]!);
    const biases = pseudoranges.map(
      (pseudorange, receiverIndex) => pseudorange - distanceBetween(sourcePosition, squareReceivers[receiverIndex]!),
    );
    for (const bias of biases) expect(bias).toBeCloseTo(biases[0]!, 9);
  });

  it('exige un intervalo por micrófono', () => {
    expect(() => pseudorangesFromIntervals([1, 2], triangleReceivers, triangleReceivers[0]!, speedOfSound)).toThrow(
      RangeError,
    );
  });
});

describe('solveTdoaPosition', () => {
  it('recupera la fuente exacta con cuatro micrófonos', () => {
    const sourcePosition = { x: 0.7, y: 1.4 };
    const solution = solveTdoaPosition({
      receiverPositions: squareReceivers,
      pseudorangesMeters: pseudorangesFor(sourcePosition, squareReceivers, squareReceivers[0]!),
      rangeStandardDeviationMeters: 0.05,
    });
    expect(solution).not.toBeNull();
    expect(solution!.position.x).toBeCloseTo(0.7, 6);
    expect(solution!.position.y).toBeCloseTo(1.4, 6);
    expect(solution!.rootMeanSquareResidualMeters).toBeLessThan(1e-6);
    expect(solution!.alternativePosition).toBeNull();
    expect(solution!.errorEllipse!.semiMajorAxisMeters).toBeGreaterThan(0);
  });

  it('con tres micrófonos resuelve dentro del triángulo', () => {
    const sourcePosition = { x: 1.1, y: 0.6 };
    const solution = solveTdoaPosition({
      receiverPositions: triangleReceivers,
      pseudorangesMeters: pseudorangesFor(sourcePosition, triangleReceivers, triangleReceivers[1]!),
      rangeStandardDeviationMeters: 0.05,
    });
    expect(solution).not.toBeNull();
    expect(distanceBetween(solution!.position, sourcePosition)).toBeLessThan(1e-5);
  });

  it('con tres micrófonos y la fuente lejos, ofrece también la segunda solución', () => {
    const receiverPositions = triangleReceivers;
    let ambiguousCaseCount = 0;
    for (const sourcePosition of [
      { x: -7, y: -7 },
      { x: -6, y: -2 },
      { x: -6.5, y: -1 },
    ]) {
      const solution = solveTdoaPosition({
        receiverPositions,
        pseudorangesMeters: pseudorangesFor(sourcePosition, receiverPositions, receiverPositions[0]!),
        rangeStandardDeviationMeters: 0.05,
      });
      expect(solution).not.toBeNull();
      const bestError = distanceBetween(solution!.position, sourcePosition);
      const alternativeError = solution!.alternativePosition
        ? distanceBetween(solution!.alternativePosition, sourcePosition)
        : Infinity;
      // La fuente verdadera es una de las dos soluciones que se ofrecen.
      expect(Math.min(bestError, alternativeError)).toBeLessThan(1e-3);
      if (solution!.alternativePosition) ambiguousCaseCount++;
    }
    expect(ambiguousCaseCount).toBe(3);
  });

  it('con tres micrófonos y la fuente cerca, la solución es única', () => {
    for (const sourcePosition of [
      { x: 4, y: 3 },
      { x: -3, y: 2.5 },
      { x: 1, y: -3 },
    ]) {
      const solution = solveTdoaPosition({
        receiverPositions: triangleReceivers,
        pseudorangesMeters: pseudorangesFor(sourcePosition, triangleReceivers, triangleReceivers[0]!),
        rangeStandardDeviationMeters: 0.05,
      });
      expect(distanceBetween(solution!.position, sourcePosition)).toBeLessThan(1e-4);
      expect(solution!.alternativePosition).toBeNull();
    }
  });

  it('con ruido, la fuente cae dentro de la elipse del 95 % casi siempre', () => {
    const nextRandom = createSeededRandom(21);
    const gaussian = () => {
      const firstUniform = Math.max(1e-12, nextRandom());
      return Math.sqrt(-2 * Math.log(firstUniform)) * Math.cos(2 * Math.PI * nextRandom());
    };
    const rangeStandardDeviation = 0.03;
    const sourcePosition = { x: 1.2, y: 0.8 };
    const exactPseudoranges = pseudorangesFor(sourcePosition, squareReceivers, squareReceivers[0]!);
    let insideCount = 0;
    const trialCount = 200;
    for (let trialIndex = 0; trialIndex < trialCount; trialIndex++) {
      const noisyPseudoranges = exactPseudoranges.map((pseudorange) => pseudorange + rangeStandardDeviation * gaussian());
      const solution = solveTdoaPosition({
        receiverPositions: squareReceivers,
        pseudorangesMeters: noisyPseudoranges,
        rangeStandardDeviationMeters: rangeStandardDeviation,
      })!;
      const { errorEllipse } = solution;
      const offsetX = sourcePosition.x - errorEllipse!.center.x;
      const offsetY = sourcePosition.y - errorEllipse!.center.y;
      const cosine = Math.cos(errorEllipse!.orientationRadians);
      const sine = Math.sin(errorEllipse!.orientationRadians);
      const alongMajor = (offsetX * cosine + offsetY * sine) / errorEllipse!.semiMajorAxisMeters;
      const alongMinor = (-offsetX * sine + offsetY * cosine) / errorEllipse!.semiMinorAxisMeters;
      if (alongMajor ** 2 + alongMinor ** 2 <= 1) insideCount++;
    }
    // La desviación usada es max(supuesta, residuos): algo conservadora.
    expect(insideCount / trialCount).toBeGreaterThan(0.9);
  });

  it('rechaza datos incompletos', () => {
    expect(
      solveTdoaPosition({
        receiverPositions: triangleReceivers.slice(0, 2),
        pseudorangesMeters: [1, 2],
        rangeStandardDeviationMeters: 0.05,
      }),
    ).toBeNull();
    expect(
      solveTdoaPosition({
        receiverPositions: triangleReceivers,
        pseudorangesMeters: [1, Number.NaN, 2],
        rangeStandardDeviationMeters: 0.05,
      }),
    ).toBeNull();
  });
});

describe('errorEllipseFromCovariance', () => {
  it('orienta el eje mayor según la covarianza', () => {
    const ellipse = errorEllipseFromCovariance({ x: 0, y: 0 }, { xx: 1, xy: 0, yy: 0.25 }, 1);
    expect(ellipse.semiMajorAxisMeters).toBeCloseTo(1, 9);
    expect(ellipse.semiMinorAxisMeters).toBeCloseTo(0.5, 9);
    expect(ellipse.orientationRadians).toBeCloseTo(0, 9);
    const rotatedEllipse = errorEllipseFromCovariance({ x: 0, y: 0 }, { xx: 0.5, xy: 0.5, yy: 0.5 }, 1);
    expect(rotatedEllipse.orientationRadians).toBeCloseTo(Math.PI / 4, 9);
    expect(rotatedEllipse.semiMinorAxisMeters).toBeCloseTo(0, 6);
  });
});

describe('sampleHyperbolaBranch', () => {
  it('todos sus puntos cumplen la diferencia de distancias pedida', () => {
    const focusA = { x: 0, y: 0 };
    const focusB = { x: 2, y: 1 };
    for (const rangeDifference of [-1.2, -0.3, 0, 0.5, 1.9]) {
      const branchPoints = sampleHyperbolaBranch(focusA, focusB, rangeDifference, 10);
      expect(branchPoints).not.toBeNull();
      for (const branchPoint of branchPoints!) {
        expect(distanceBetween(branchPoint, focusB) - distanceBetween(branchPoint, focusA)).toBeCloseTo(rangeDifference, 9);
      }
    }
  });

  it('no existe si la diferencia supera la distancia entre focos', () => {
    expect(sampleHyperbolaBranch({ x: 0, y: 0 }, { x: 1, y: 0 }, 1.2, 10)).toBeNull();
  });
});

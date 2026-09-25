import { createSeededRandom } from '../dsp/signalGenerator';
import {
  computeSearchBounds,
  computeTheoreticalArrivals,
  estimateSpeedFromKnownSource,
  fitTravelTimeLine,
  locateSource,
  mapCompatibleRegion,
  type StationArrival,
} from './localization';

/** Cinco móviles en una mesa de 3 × 1 m (esquinas y centro). */
const tableStations = [
  { xMeters: 0, yMeters: 0 },
  { xMeters: 3, yMeters: 0 },
  { xMeters: 0, yMeters: 1 },
  { xMeters: 3, yMeters: 1 },
  { xMeters: 1.5, yMeters: 0.5 },
];

function addTimingNoise(arrivals: StationArrival[], noiseSeconds: number, seed: number): StationArrival[] {
  const nextRandom = createSeededRandom(seed);
  return arrivals.map((arrival) => ({ ...arrival, arrivalSeconds: arrival.arrivalSeconds + noiseSeconds * (nextRandom() * 2 - 1) }));
}

describe('fitTravelTimeLine', () => {
  it('recupera t₀ y la lentitud de datos exactos', () => {
    const travelTimeFit = fitTravelTimeLine([0.5, 1, 2, 3], [0.1 + 0.5 / 400, 0.1 + 1 / 400, 0.1 + 2 / 400, 0.1 + 3 / 400]);
    expect(travelTimeFit!.slownessSecondsPerMeter).toBeCloseTo(1 / 400, 10);
    expect(travelTimeFit!.originTimeSeconds).toBeCloseTo(0.1, 10);
    expect(travelTimeFit!.sumSquaredResidualsSeconds2).toBeCloseTo(0, 12);
  });

  it('devuelve null si todas las distancias son iguales', () => {
    expect(fitTravelTimeLine([1, 1, 1], [0.1, 0.2, 0.3])).toBeNull();
  });
});

describe('estimateSpeedFromKnownSource', () => {
  it('mide la velocidad con el foco conocido y dos estaciones', () => {
    const arrivals = computeTheoreticalArrivals(tableStations.slice(0, 2), { xMeters: -0.5, yMeters: 0 }, 350, 12.3);
    const speedEstimate = estimateSpeedFromKnownSource(arrivals, { xMeters: -0.5, yMeters: 0 });
    expect(speedEstimate!.apparentSpeedMetersPerSecond).toBeCloseTo(350, 6);
    expect(speedEstimate!.originTimeSeconds).toBeCloseTo(12.3, 9);
    expect(speedEstimate!.rmsResidualSeconds).toBeLessThan(1e-9);
  });

  it('rechaza tiempos que bajan con la distancia', () => {
    const arrivals = [
      { xMeters: 1, yMeters: 0, arrivalSeconds: 0.02 },
      { xMeters: 2, yMeters: 0, arrivalSeconds: 0.01 },
    ];
    expect(estimateSpeedFromKnownSource(arrivals, { xMeters: 0, yMeters: 0 })).toBeNull();
  });

  it('con errores de cronometraje de 1 ms da la velocidad con un error moderado', () => {
    const source = { xMeters: -0.2, yMeters: 0.5 };
    const arrivals = addTimingNoise(computeTheoreticalArrivals(tableStations, source, 300, 5), 0.001, 4);
    const speedEstimate = estimateSpeedFromKnownSource(arrivals, source);
    expect(Math.abs(speedEstimate!.apparentSpeedMetersPerSecond - 300) / 300).toBeLessThan(0.25);
    expect(speedEstimate!.residualsSeconds).toHaveLength(tableStations.length);
  });
});

describe('locateSource', () => {
  it('localiza el foco y la velocidad con datos exactos dentro de la red', () => {
    const source = { xMeters: 2.2, yMeters: 0.3 };
    const arrivals = computeTheoreticalArrivals(tableStations, source, 500, 42);
    const sourceLocation = locateSource(arrivals);
    expect(sourceLocation!.sourceXMeters).toBeCloseTo(2.2, 2);
    expect(sourceLocation!.sourceYMeters).toBeCloseTo(0.3, 2);
    expect(sourceLocation!.apparentSpeedMetersPerSecond).toBeCloseTo(500, -1);
    expect(sourceLocation!.originTimeSeconds).toBeCloseTo(42, 4);
    expect(sourceLocation!.isAtSearchBoundary).toBe(false);
    expect(sourceLocation!.fittedParameterCount).toBe(4);
  });

  it('con cuatro estaciones (el mínimo) el ajuste es exacto pero puede haber dos focos; la quinta lo resuelve', () => {
    const source = { xMeters: 0.4, yMeters: 0.8 };
    const fourStationLocation = locateSource(computeTheoreticalArrivals(tableStations.slice(0, 4), source, 250));
    // Cuatro ecuaciones y cuatro incógnitas: la solución encaja perfectamente, pero en esta
    // geometría hay otra igual de buena (-0,62; 1,08) y el algoritmo no puede distinguirlas.
    expect(fourStationLocation!.rmsResidualSeconds).toBeLessThan(1e-6);
    const fiveStationLocation = locateSource(computeTheoreticalArrivals(tableStations, source, 250));
    expect(Math.hypot(fiveStationLocation!.sourceXMeters - 0.4, fiveStationLocation!.sourceYMeters - 0.8)).toBeLessThan(0.02);
  });

  it('pide al menos cuatro estaciones si la velocidad es libre y tres si es conocida', () => {
    const arrivals = computeTheoreticalArrivals(tableStations.slice(0, 3), { xMeters: 1, yMeters: 0.5 }, 300);
    expect(locateSource(arrivals)).toBeNull();
    const sourceLocation = locateSource(arrivals, { fixedSpeedMetersPerSecond: 300 });
    expect(sourceLocation!.sourceXMeters).toBeCloseTo(1, 2);
    expect(sourceLocation!.sourceYMeters).toBeCloseTo(0.5, 2);
    expect(sourceLocation!.apparentSpeedMetersPerSecond).toBeCloseTo(300, 6);
    expect(sourceLocation!.fittedParameterCount).toBe(3);
  });

  it('con 1 ms de error en los tiempos, el foco sale a pocos centímetros', () => {
    const source = { xMeters: 1.1, yMeters: 0.6 };
    const arrivals = addTimingNoise(computeTheoreticalArrivals(tableStations, source, 200), 0.001, 11);
    const sourceLocation = locateSource(arrivals);
    expect(Math.hypot(sourceLocation!.sourceXMeters - 1.1, sourceLocation!.sourceYMeters - 0.6)).toBeLessThan(0.25);
    expect(sourceLocation!.rmsResidualSeconds).toBeLessThan(0.0015);
  });

  it('avisa cuando el mejor punto queda en el borde de la zona de búsqueda', () => {
    const farSource = { xMeters: 20, yMeters: 0.5 };
    const arrivals = computeTheoreticalArrivals(tableStations, farSource, 300);
    const sourceLocation = locateSource(arrivals);
    expect(sourceLocation!.isAtSearchBoundary).toBe(true);
  });
});

describe('computeSearchBounds', () => {
  it('amplía el rectángulo de las estaciones con un margen', () => {
    expect(computeSearchBounds(tableStations)).toEqual({
      minimumXMeters: -1.5,
      maximumXMeters: 4.5,
      minimumYMeters: -1.5,
      maximumYMeters: 2.5,
    });
  });
});

describe('mapCompatibleRegion', () => {
  it('contiene el foco verdadero y es más pequeña con menos error de cronometraje', () => {
    const source = { xMeters: 1.8, yMeters: 0.4 };
    const arrivals = addTimingNoise(computeTheoreticalArrivals(tableStations, source, 300), 0.0005, 2);
    const sourceLocation = locateSource(arrivals)!;
    const preciseRegion = mapCompatibleRegion(arrivals, sourceLocation, { timingUncertaintySeconds: 0.001 });
    const sloppyRegion = mapCompatibleRegion(arrivals, sourceLocation, { timingUncertaintySeconds: 0.005 });
    expect(preciseRegion.length).toBeGreaterThan(0);
    expect(sloppyRegion.length).toBeGreaterThan(preciseRegion.length);
    const cellSizeMeters = 6 / 40;
    const containsTrueSource = preciseRegion.some(
      (regionPoint) => Math.abs(regionPoint.xMeters - 1.8) <= cellSizeMeters && Math.abs(regionPoint.yMeters - 0.4) <= cellSizeMeters,
    );
    expect(containsTrueSource).toBe(true);
  });
});

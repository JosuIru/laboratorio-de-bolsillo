/**
 * Localización del epicentro y estimación de la velocidad a partir de las horas de llegada.
 *
 * Modelo de medio homogéneo en un plano: una estación a distancia d del foco recibe la onda en
 * t = t₀ + d / v. Las incógnitas son la posición del foco (x, y), el instante del golpe t₀ y
 * la velocidad v. Para una posición de prueba dada, t₀ y la lentitud 1/v salen por mínimos
 * cuadrados lineales (una recta t frente a d); la posición se busca en una rejilla que se va
 * afinando. Así no hace falta un punto de partida ni se cae en mínimos locales.
 */

export interface PlanePoint {
  xMeters: number;
  yMeters: number;
}

export interface StationArrival extends PlanePoint {
  /** Hora de llegada en segundos, en la escala de tiempo común (ya sincronizada). */
  arrivalSeconds: number;
}

export interface SearchBounds {
  minimumXMeters: number;
  maximumXMeters: number;
  minimumYMeters: number;
  maximumYMeters: number;
}

export interface TravelTimeFit {
  originTimeSeconds: number;
  /** Lentitud 1/v en s/m. */
  slownessSecondsPerMeter: number;
  sumSquaredResidualsSeconds2: number;
}

export interface SpeedEstimate {
  apparentSpeedMetersPerSecond: number;
  originTimeSeconds: number;
  rmsResidualSeconds: number;
  /** Observado − calculado, por estación y en el mismo orden. */
  residualsSeconds: number[];
  distancesMeters: number[];
}

export interface SourceLocation extends SpeedEstimate {
  sourceXMeters: number;
  sourceYMeters: number;
  searchBounds: SearchBounds;
  /** El mínimo está en el borde de la zona de búsqueda: el foco puede estar fuera de la red. */
  isAtSearchBoundary: boolean;
  /** Número de incógnitas del ajuste (4, o 3 si la velocidad es conocida). */
  fittedParameterCount: number;
}

export const minimumStationsForFreeLocation = 4;
export const minimumStationsForKnownSpeed = 3;
export const minimumStationsForKnownSource = 2;

export function distanceBetween(firstPoint: PlanePoint, secondPoint: PlanePoint): number {
  return Math.hypot(firstPoint.xMeters - secondPoint.xMeters, firstPoint.yMeters - secondPoint.yMeters);
}

/**
 * Recta t = t₀ + s·d por mínimos cuadrados. Devuelve `null` si todas las distancias son
 * iguales (la pendiente queda indeterminada).
 */
export function fitTravelTimeLine(distancesMeters: ArrayLike<number>, arrivalsSeconds: ArrayLike<number>): TravelTimeFit | null {
  const pointCount = distancesMeters.length;
  if (pointCount < 2) return null;
  let distanceSum = 0;
  let arrivalSum = 0;
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    distanceSum += distancesMeters[pointIndex]!;
    arrivalSum += arrivalsSeconds[pointIndex]!;
  }
  const meanDistance = distanceSum / pointCount;
  const meanArrival = arrivalSum / pointCount;
  let distanceVarianceSum = 0;
  let covarianceSum = 0;
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    const centeredDistance = distancesMeters[pointIndex]! - meanDistance;
    distanceVarianceSum += centeredDistance * centeredDistance;
    covarianceSum += centeredDistance * (arrivalsSeconds[pointIndex]! - meanArrival);
  }
  if (distanceVarianceSum < 1e-12) return null;
  const slownessSecondsPerMeter = covarianceSum / distanceVarianceSum;
  const originTimeSeconds = meanArrival - slownessSecondsPerMeter * meanDistance;
  let sumSquaredResidualsSeconds2 = 0;
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    const residual =
      arrivalsSeconds[pointIndex]! - originTimeSeconds - slownessSecondsPerMeter * distancesMeters[pointIndex]!;
    sumSquaredResidualsSeconds2 += residual * residual;
  }
  return { originTimeSeconds, slownessSecondsPerMeter, sumSquaredResidualsSeconds2 };
}

function buildSpeedEstimate(
  arrivals: readonly StationArrival[],
  source: PlanePoint,
  originTimeSeconds: number,
  slownessSecondsPerMeter: number,
): SpeedEstimate {
  const distancesMeters = arrivals.map((arrival) => distanceBetween(arrival, source));
  const residualsSeconds = arrivals.map(
    (arrival, stationIndex) =>
      arrival.arrivalSeconds - originTimeSeconds - slownessSecondsPerMeter * distancesMeters[stationIndex]!,
  );
  const sumSquaredResiduals = residualsSeconds.reduce((runningSum, residual) => runningSum + residual * residual, 0);
  return {
    apparentSpeedMetersPerSecond: 1 / slownessSecondsPerMeter,
    originTimeSeconds,
    rmsResidualSeconds: Math.sqrt(sumSquaredResiduals / arrivals.length),
    residualsSeconds,
    distancesMeters,
  };
}

/**
 * Velocidad aparente cuando se sabe dónde fue el golpe (el profesor lo marca en el plano).
 * Basta con dos estaciones a distancias distintas; con más, el ajuste promedia errores.
 * Devuelve `null` si los tiempos no crecen con la distancia (medida incoherente).
 */
export function estimateSpeedFromKnownSource(arrivals: readonly StationArrival[], source: PlanePoint): SpeedEstimate | null {
  if (arrivals.length < minimumStationsForKnownSource) return null;
  const travelTimeFit = fitTravelTimeLine(
    arrivals.map((arrival) => distanceBetween(arrival, source)),
    arrivals.map((arrival) => arrival.arrivalSeconds),
  );
  if (!travelTimeFit || travelTimeFit.slownessSecondsPerMeter <= 0) return null;
  return buildSpeedEstimate(arrivals, source, travelTimeFit.originTimeSeconds, travelTimeFit.slownessSecondsPerMeter);
}

/** Mejor t₀ (y lentitud) para un foco de prueba; `null` si el punto no es físicamente válido. */
function evaluateTrialSource(
  arrivals: readonly StationArrival[],
  trialSource: PlanePoint,
  fixedSlownessSecondsPerMeter: number | null,
): TravelTimeFit | null {
  const distancesMeters = arrivals.map((arrival) => distanceBetween(arrival, trialSource));
  if (fixedSlownessSecondsPerMeter !== null) {
    const originTimeSeconds =
      arrivals.reduce(
        (runningSum, arrival, stationIndex) =>
          runningSum + arrival.arrivalSeconds - fixedSlownessSecondsPerMeter * distancesMeters[stationIndex]!,
        0,
      ) / arrivals.length;
    let sumSquaredResidualsSeconds2 = 0;
    arrivals.forEach((arrival, stationIndex) => {
      const residual =
        arrival.arrivalSeconds - originTimeSeconds - fixedSlownessSecondsPerMeter * distancesMeters[stationIndex]!;
      sumSquaredResidualsSeconds2 += residual * residual;
    });
    return { originTimeSeconds, slownessSecondsPerMeter: fixedSlownessSecondsPerMeter, sumSquaredResidualsSeconds2 };
  }
  const travelTimeFit = fitTravelTimeLine(
    distancesMeters,
    arrivals.map((arrival) => arrival.arrivalSeconds),
  );
  // Una onda no llega antes a las estaciones más lejanas: la lentitud debe ser positiva.
  if (!travelTimeFit || travelTimeFit.slownessSecondsPerMeter <= 0) return null;
  return travelTimeFit;
}

/** Rectángulo que contiene las estaciones, ampliado un margen por cada lado. */
export function computeSearchBounds(points: readonly PlanePoint[], marginFraction = 0.5, minimumMarginMeters = 0.5): SearchBounds {
  const xValues = points.map((point) => point.xMeters);
  const yValues = points.map((point) => point.yMeters);
  const minimumX = Math.min(...xValues);
  const maximumX = Math.max(...xValues);
  const minimumY = Math.min(...yValues);
  const maximumY = Math.max(...yValues);
  const networkExtentMeters = Math.max(maximumX - minimumX, maximumY - minimumY);
  const marginMeters = Math.max(minimumMarginMeters, networkExtentMeters * marginFraction);
  return {
    minimumXMeters: minimumX - marginMeters,
    maximumXMeters: maximumX + marginMeters,
    minimumYMeters: minimumY - marginMeters,
    maximumYMeters: maximumY + marginMeters,
  };
}

interface GridSearchResult {
  bestPoint: PlanePoint;
  bestFit: TravelTimeFit;
}

function searchGrid(
  arrivals: readonly StationArrival[],
  searchBounds: SearchBounds,
  cellsPerSide: number,
  fixedSlownessSecondsPerMeter: number | null,
): GridSearchResult | null {
  let bestResult: GridSearchResult | null = null;
  for (let columnIndex = 0; columnIndex <= cellsPerSide; columnIndex++) {
    const trialX =
      searchBounds.minimumXMeters + ((searchBounds.maximumXMeters - searchBounds.minimumXMeters) * columnIndex) / cellsPerSide;
    for (let rowIndex = 0; rowIndex <= cellsPerSide; rowIndex++) {
      const trialY =
        searchBounds.minimumYMeters + ((searchBounds.maximumYMeters - searchBounds.minimumYMeters) * rowIndex) / cellsPerSide;
      const trialPoint = { xMeters: trialX, yMeters: trialY };
      const trialFit = evaluateTrialSource(arrivals, trialPoint, fixedSlownessSecondsPerMeter);
      if (!trialFit) continue;
      if (!bestResult || trialFit.sumSquaredResidualsSeconds2 < bestResult.bestFit.sumSquaredResidualsSeconds2) {
        bestResult = { bestPoint: trialPoint, bestFit: trialFit };
      }
    }
  }
  return bestResult;
}

export interface LocateSourceOptions {
  /** Si se conoce la velocidad del medio, basta con tres estaciones. */
  fixedSpeedMetersPerSecond?: number;
  searchBounds?: SearchBounds;
  coarseCellsPerSide?: number;
  refinementSteps?: number;
}

/**
 * Epicentro (y velocidad, si no se da) por mínimos cuadrados: rejilla gruesa sobre la zona de
 * búsqueda y varias rejillas más finas alrededor del mejor punto.
 */
export function locateSource(arrivals: readonly StationArrival[], options: LocateSourceOptions = {}): SourceLocation | null {
  const { fixedSpeedMetersPerSecond, coarseCellsPerSide = 60, refinementSteps = 8 } = options;
  const hasFixedSpeed = fixedSpeedMetersPerSecond !== undefined && fixedSpeedMetersPerSecond > 0;
  const minimumStations = hasFixedSpeed ? minimumStationsForKnownSpeed : minimumStationsForFreeLocation;
  if (arrivals.length < minimumStations) return null;
  const fixedSlownessSecondsPerMeter = hasFixedSpeed ? 1 / fixedSpeedMetersPerSecond : null;
  const searchBounds = options.searchBounds ?? computeSearchBounds(arrivals);

  let gridResult = searchGrid(arrivals, searchBounds, coarseCellsPerSide, fixedSlownessSecondsPerMeter);
  if (!gridResult) return null;
  let cellWidthMeters = (searchBounds.maximumXMeters - searchBounds.minimumXMeters) / coarseCellsPerSide;
  let cellHeightMeters = (searchBounds.maximumYMeters - searchBounds.minimumYMeters) / coarseCellsPerSide;
  const refinementCellsPerSide = 20;
  for (let refinementIndex = 0; refinementIndex < refinementSteps; refinementIndex++) {
    const { xMeters, yMeters } = gridResult.bestPoint;
    const refinedBounds: SearchBounds = {
      minimumXMeters: Math.max(searchBounds.minimumXMeters, xMeters - 2 * cellWidthMeters),
      maximumXMeters: Math.min(searchBounds.maximumXMeters, xMeters + 2 * cellWidthMeters),
      minimumYMeters: Math.max(searchBounds.minimumYMeters, yMeters - 2 * cellHeightMeters),
      maximumYMeters: Math.min(searchBounds.maximumYMeters, yMeters + 2 * cellHeightMeters),
    };
    const refinedResult = searchGrid(arrivals, refinedBounds, refinementCellsPerSide, fixedSlownessSecondsPerMeter);
    if (refinedResult && refinedResult.bestFit.sumSquaredResidualsSeconds2 <= gridResult.bestFit.sumSquaredResidualsSeconds2) {
      gridResult = refinedResult;
    }
    cellWidthMeters = (refinedBounds.maximumXMeters - refinedBounds.minimumXMeters) / refinementCellsPerSide;
    cellHeightMeters = (refinedBounds.maximumYMeters - refinedBounds.minimumYMeters) / refinementCellsPerSide;
  }

  const { bestPoint, bestFit } = gridResult;
  const boundaryToleranceMeters =
    1e-6 + 0.01 * Math.max(searchBounds.maximumXMeters - searchBounds.minimumXMeters, searchBounds.maximumYMeters - searchBounds.minimumYMeters);
  const isAtSearchBoundary =
    bestPoint.xMeters - searchBounds.minimumXMeters < boundaryToleranceMeters ||
    searchBounds.maximumXMeters - bestPoint.xMeters < boundaryToleranceMeters ||
    bestPoint.yMeters - searchBounds.minimumYMeters < boundaryToleranceMeters ||
    searchBounds.maximumYMeters - bestPoint.yMeters < boundaryToleranceMeters;

  return {
    ...buildSpeedEstimate(arrivals, bestPoint, bestFit.originTimeSeconds, bestFit.slownessSecondsPerMeter),
    sourceXMeters: bestPoint.xMeters,
    sourceYMeters: bestPoint.yMeters,
    searchBounds,
    isAtSearchBoundary,
    fittedParameterCount: hasFixedSpeed ? 3 : 4,
  };
}

/** Cuantil 95 % de χ² con 2 grados de libertad (las dos coordenadas del foco). */
const chiSquare95TwoDegrees = 5.991;

export interface CompatibleRegionOptions {
  /** Error típico de una hora de llegada (un intervalo de muestreo o algo más). */
  timingUncertaintySeconds: number;
  cellsPerSide?: number;
  fixedSpeedMetersPerSecond?: number;
}

/**
 * Puntos de la rejilla donde el foco es compatible con las medidas (región de confianza del
 * 95 % aproximada): allí el error cuadrático apenas supera al del mejor punto, teniendo en
 * cuenta el error de cronometraje. Es la «mancha» de incertidumbre que se dibuja en el plano;
 * si la red rodea el foco sale pequeña, y si el foco queda fuera se alarga hacia fuera.
 */
export function mapCompatibleRegion(
  arrivals: readonly StationArrival[],
  sourceLocation: SourceLocation,
  options: CompatibleRegionOptions,
): PlanePoint[] {
  const { timingUncertaintySeconds, cellsPerSide = 40, fixedSpeedMetersPerSecond } = options;
  const fixedSlownessSecondsPerMeter =
    fixedSpeedMetersPerSecond !== undefined && fixedSpeedMetersPerSecond > 0 ? 1 / fixedSpeedMetersPerSecond : null;
  const bestSumSquared = sourceLocation.rmsResidualSeconds ** 2 * arrivals.length;
  const degreesOfFreedom = arrivals.length - sourceLocation.fittedParameterCount;
  // Si sobran estaciones, el propio residuo dice cuánto error hay; nunca menos que el cronometraje.
  const effectiveSigmaSeconds = Math.max(
    timingUncertaintySeconds,
    degreesOfFreedom > 0 ? Math.sqrt(bestSumSquared / degreesOfFreedom) : 0,
  );
  const acceptanceLimit = bestSumSquared + chiSquare95TwoDegrees * effectiveSigmaSeconds ** 2;
  const { searchBounds } = sourceLocation;
  const compatiblePoints: PlanePoint[] = [];
  for (let columnIndex = 0; columnIndex <= cellsPerSide; columnIndex++) {
    const trialX =
      searchBounds.minimumXMeters + ((searchBounds.maximumXMeters - searchBounds.minimumXMeters) * columnIndex) / cellsPerSide;
    for (let rowIndex = 0; rowIndex <= cellsPerSide; rowIndex++) {
      const trialY =
        searchBounds.minimumYMeters + ((searchBounds.maximumYMeters - searchBounds.minimumYMeters) * rowIndex) / cellsPerSide;
      const trialFit = evaluateTrialSource(arrivals, { xMeters: trialX, yMeters: trialY }, fixedSlownessSecondsPerMeter);
      if (trialFit && trialFit.sumSquaredResidualsSeconds2 <= acceptanceLimit) {
        compatiblePoints.push({ xMeters: trialX, yMeters: trialY });
      }
    }
  }
  return compatiblePoints;
}

/** Horas de llegada teóricas (para ejemplos y pruebas): t = t₀ + d / v. */
export function computeTheoreticalArrivals(
  stations: readonly PlanePoint[],
  source: PlanePoint,
  speedMetersPerSecond: number,
  originTimeSeconds = 0,
): StationArrival[] {
  return stations.map((station) => ({
    xMeters: station.xMeters,
    yMeters: station.yMeters,
    arrivalSeconds: originTimeSeconds + distanceBetween(station, source) / speedMetersPerSecond,
  }));
}

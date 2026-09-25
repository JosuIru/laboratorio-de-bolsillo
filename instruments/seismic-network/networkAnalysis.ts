import {
  computeSearchBounds,
  computeTheoreticalArrivals,
  estimateSpeedFromKnownSource,
  locateSource,
  mapCompatibleRegion,
  minimumStationsForFreeLocation,
  minimumStationsForKnownSource,
  minimumStationsForKnownSpeed,
  type PlanePoint,
  type SearchBounds,
  type StationArrival,
} from '@/processing/seismology/localization';

import type { StationReading } from './stationMessages';

/**
 * - `free`: se buscan foco y velocidad (4 estaciones o más).
 * - `known-speed`: la velocidad se midió antes; se busca solo el foco (3 o más).
 * - `known-source`: se sabe dónde fue el golpe; se mide la velocidad (2 o más).
 */
export type LocationMethod = 'free' | 'known-speed' | 'known-source';

export interface NetworkAnalysisInput {
  stations: readonly StationReading[];
  method: LocationMethod;
  knownSource?: PlanePoint | null;
  knownSpeedMetersPerSecond?: number | null;
  timingUncertaintySeconds: number;
}

export type NetworkAnalysis =
  | { status: 'not-enough-stations'; requiredStationCount: number; mapBounds: SearchBounds | null }
  | { status: 'missing-parameter'; mapBounds: SearchBounds | null }
  | { status: 'no-solution'; mapBounds: SearchBounds }
  | {
      status: 'solved';
      method: LocationMethod;
      source: PlanePoint;
      apparentSpeedMetersPerSecond: number;
      originTimeSeconds: number;
      rmsResidualSeconds: number;
      residualsSeconds: number[];
      compatibleRegion: PlanePoint[];
      mapBounds: SearchBounds;
      /** El foco sale en el borde de la zona de búsqueda: probablemente está fuera de la red. */
      isAtSearchBoundary: boolean;
      /** Solo con el mínimo de estaciones: el ajuste es exacto y puede haber otra solución. */
      hasNoRedundancy: boolean;
      /** Residuo mucho mayor que el error de cronometraje: alguna llegada está mal. */
      hasLargeResidual: boolean;
    };

const requiredStationsByMethod: Record<LocationMethod, number> = {
  free: minimumStationsForFreeLocation,
  'known-speed': minimumStationsForKnownSpeed,
  'known-source': minimumStationsForKnownSource,
};

/** Estaciones repetidas en el mismo punto no aportan geometría: se cuentan una vez. */
function countDistinctPositions(stations: readonly PlanePoint[]): number {
  return new Set(stations.map((station) => `${station.xMeters.toFixed(3)};${station.yMeters.toFixed(3)}`)).size;
}

export function analyzeNetwork(input: NetworkAnalysisInput): NetworkAnalysis {
  const { stations, method, knownSource, knownSpeedMetersPerSecond, timingUncertaintySeconds } = input;
  const mapPoints: PlanePoint[] = [...stations];
  if (method === 'known-source' && knownSource) mapPoints.push(knownSource);
  const mapBounds = mapPoints.length > 0 ? computeSearchBounds(mapPoints) : null;

  const requiredStationCount = requiredStationsByMethod[method];
  if (stations.length < requiredStationCount || countDistinctPositions(stations) < requiredStationCount) {
    return { status: 'not-enough-stations', requiredStationCount, mapBounds };
  }
  if (method === 'known-source' && !knownSource) return { status: 'missing-parameter', mapBounds };
  if (method === 'known-speed' && !(knownSpeedMetersPerSecond && knownSpeedMetersPerSecond > 0)) {
    return { status: 'missing-parameter', mapBounds };
  }

  const arrivals: StationArrival[] = stations.map((station) => ({
    xMeters: station.xMeters,
    yMeters: station.yMeters,
    arrivalSeconds: station.arrivalSeconds,
  }));
  const safeMapBounds = mapBounds!;
  const hasNoRedundancy = stations.length === requiredStationCount;

  if (method === 'known-source') {
    const speedEstimate = estimateSpeedFromKnownSource(arrivals, knownSource!);
    if (!speedEstimate) return { status: 'no-solution', mapBounds: safeMapBounds };
    return {
      status: 'solved',
      method,
      source: knownSource!,
      apparentSpeedMetersPerSecond: speedEstimate.apparentSpeedMetersPerSecond,
      originTimeSeconds: speedEstimate.originTimeSeconds,
      rmsResidualSeconds: speedEstimate.rmsResidualSeconds,
      residualsSeconds: speedEstimate.residualsSeconds,
      compatibleRegion: [],
      mapBounds: safeMapBounds,
      isAtSearchBoundary: false,
      hasNoRedundancy,
      hasLargeResidual: speedEstimate.rmsResidualSeconds > 2 * timingUncertaintySeconds,
    };
  }

  const fixedSpeedMetersPerSecond = method === 'known-speed' ? knownSpeedMetersPerSecond! : undefined;
  const sourceLocation = locateSource(arrivals, { searchBounds: safeMapBounds, fixedSpeedMetersPerSecond });
  if (!sourceLocation) return { status: 'no-solution', mapBounds: safeMapBounds };
  return {
    status: 'solved',
    method,
    source: { xMeters: sourceLocation.sourceXMeters, yMeters: sourceLocation.sourceYMeters },
    apparentSpeedMetersPerSecond: sourceLocation.apparentSpeedMetersPerSecond,
    originTimeSeconds: sourceLocation.originTimeSeconds,
    rmsResidualSeconds: sourceLocation.rmsResidualSeconds,
    residualsSeconds: sourceLocation.residualsSeconds,
    compatibleRegion: mapCompatibleRegion(arrivals, sourceLocation, { timingUncertaintySeconds, fixedSpeedMetersPerSecond }),
    mapBounds: safeMapBounds,
    isAtSearchBoundary: sourceLocation.isAtSearchBoundary,
    hasNoRedundancy,
    hasLargeResidual: sourceLocation.rmsResidualSeconds > 2 * timingUncertaintySeconds,
  };
}

/**
 * Datos de ejemplo para probar la central sin móviles: seis estaciones en una mesa de
 * 3 × 1,2 m, golpe en (2,2; 0,4), 300 m/s, con errores de cronometraje de hasta 1 ms.
 */
export function buildDemoReadings(): StationReading[] {
  const demoStations = [
    { stationName: 'A', xMeters: 0, yMeters: 0 },
    { stationName: 'B', xMeters: 1.5, yMeters: 0 },
    { stationName: 'C', xMeters: 3, yMeters: 0 },
    { stationName: 'D', xMeters: 0, yMeters: 1.2 },
    { stationName: 'E', xMeters: 1.5, yMeters: 1.2 },
    { stationName: 'F', xMeters: 3, yMeters: 1.2 },
  ];
  const timingErrorsSeconds = [0.0006, -0.0009, 0.0003, -0.0004, 0.001, -0.0002];
  const theoreticalArrivals = computeTheoreticalArrivals(demoStations, { xMeters: 2.2, yMeters: 0.4 }, 300, 37.5);
  return demoStations.map((demoStation, stationIndex) => ({
    ...demoStation,
    arrivalSeconds: Number((theoreticalArrivals[stationIndex]!.arrivalSeconds + timingErrorsSeconds[stationIndex]!).toFixed(4)),
  }));
}

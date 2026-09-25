import { classifyCarrierBand, constellationFromAndroidCode } from './constellations';
import { computePseudorangeMeters } from './pseudorange';
import type { AutomaticGainControlReading, SatelliteObservation } from './types';

/**
 * Conversión de lo que entrega el módulo nativo (campos de Android casi tal cual) a las
 * estructuras del procesamiento. Los tipos son estructurales para no depender del módulo.
 */

export interface RawSatelliteStatus {
  constellationType: number;
  svid: number;
  cn0DbHz: number;
  elevationDegrees: number;
  azimuthDegrees: number;
  usedInFix: boolean;
  carrierFrequencyHz: number | null;
}

export interface RawMeasurement {
  constellationType: number;
  svid: number;
  cn0DbHz: number;
  carrierFrequencyHz: number | null;
  state: number;
  receivedSvTimeNanos: number;
  receivedSvTimeUncertaintyNanos: number;
  timeOffsetNanos: number;
  /** 0 desconocido, 1 detectado, 2 no detectado (`GnssMeasurement.MULTIPATH_INDICATOR_*`). */
  multipathIndicator: number;
  /** AGC por medida (Android 8–13). `null` si no lo hay. */
  automaticGainControlLevelDb: number | null;
}

export interface RawAutomaticGainControl {
  constellationType: number;
  carrierFrequencyHz: number;
  levelDb: number;
}

export interface RawMeasurementsEpoch {
  /** Tiempo de la semana GPS del receptor, o `null` si el reloj aún no está resuelto. */
  receiverTimeOfWeekNanos: number | null;
  measurements: readonly RawMeasurement[];
  /** AGC por banda (Android 14+). Vacío en versiones anteriores. */
  automaticGainControls: readonly RawAutomaticGainControl[];
}

export const multipathIndicatorDetected = 1;

export function toSatelliteObservations(rawSatellites: readonly RawSatelliteStatus[]): SatelliteObservation[] {
  return rawSatellites.map((rawSatellite) => {
    const constellationId = constellationFromAndroidCode(rawSatellite.constellationType);
    return {
      constellationId,
      svid: rawSatellite.svid,
      bandId: classifyCarrierBand(constellationId, rawSatellite.carrierFrequencyHz),
      carrierToNoiseDensityDbHz: Number.isFinite(rawSatellite.cn0DbHz) ? rawSatellite.cn0DbHz : 0,
      elevationDegrees: rawSatellite.elevationDegrees,
      azimuthDegrees: rawSatellite.azimuthDegrees,
      isUsedInFix: rawSatellite.usedInFix,
    };
  });
}

/**
 * Lecturas de AGC por banda: las de Android 14+ si las hay; si no, las que vienen en cada
 * medida (una por constelación y banda, promediando las repetidas).
 */
export function toAutomaticGainControlReadings(rawEpoch: RawMeasurementsEpoch): AutomaticGainControlReading[] {
  if (rawEpoch.automaticGainControls.length > 0) {
    return rawEpoch.automaticGainControls
      .filter((rawReading) => Number.isFinite(rawReading.levelDb))
      .map((rawReading) => ({
        bandId: classifyCarrierBand(constellationFromAndroidCode(rawReading.constellationType), rawReading.carrierFrequencyHz),
        levelDb: rawReading.levelDb,
      }));
  }
  const levelsByGroup = new Map<string, { reading: AutomaticGainControlReading; levelSumDb: number; count: number }>();
  for (const measurement of rawEpoch.measurements) {
    if (measurement.automaticGainControlLevelDb === null || !Number.isFinite(measurement.automaticGainControlLevelDb)) continue;
    const constellationId = constellationFromAndroidCode(measurement.constellationType);
    const bandId = classifyCarrierBand(constellationId, measurement.carrierFrequencyHz);
    const groupKey = `${constellationId}-${bandId}`;
    const group = levelsByGroup.get(groupKey) ?? { reading: { bandId, levelDb: 0 }, levelSumDb: 0, count: 0 };
    group.levelSumDb += measurement.automaticGainControlLevelDb;
    group.count += 1;
    levelsByGroup.set(groupKey, group);
  }
  return [...levelsByGroup.values()].map((group) => ({ bandId: group.reading.bandId, levelDb: group.levelSumDb / group.count }));
}

export interface RawMeasurementsSummary {
  measurementCount: number;
  pseudorangeCount: number;
  multipathDetectedCount: number;
  /** Rango de las pseudodistancias válidas (km), para comprobar que son razonables. */
  pseudorangeKilometersRange: { minimum: number; maximum: number } | null;
  /** Pseudodistancia por señal (`constelación-svid-banda`), en metros. */
  pseudorangeMetersBySignal: Map<string, number>;
}

export function summarizeRawMeasurements(rawEpoch: RawMeasurementsEpoch): RawMeasurementsSummary {
  const pseudorangeMetersBySignal = new Map<string, number>();
  let multipathDetectedCount = 0;
  for (const measurement of rawEpoch.measurements) {
    if (measurement.multipathIndicator === multipathIndicatorDetected) multipathDetectedCount += 1;
    if (rawEpoch.receiverTimeOfWeekNanos === null) continue;
    const constellationId = constellationFromAndroidCode(measurement.constellationType);
    const pseudorangeMeters = computePseudorangeMeters(
      {
        constellationId,
        state: measurement.state,
        receivedSvTimeNanos: measurement.receivedSvTimeNanos,
        receivedSvTimeUncertaintyNanos: measurement.receivedSvTimeUncertaintyNanos,
        timeOffsetNanos: measurement.timeOffsetNanos,
      },
      rawEpoch.receiverTimeOfWeekNanos,
    );
    if (pseudorangeMeters === null) continue;
    const bandId = classifyCarrierBand(constellationId, measurement.carrierFrequencyHz);
    pseudorangeMetersBySignal.set(`${constellationId}-${measurement.svid}-${bandId}`, pseudorangeMeters);
  }
  const pseudorangeKilometers = [...pseudorangeMetersBySignal.values()].map((meters) => meters / 1000);
  return {
    measurementCount: rawEpoch.measurements.length,
    pseudorangeCount: pseudorangeMetersBySignal.size,
    multipathDetectedCount,
    pseudorangeKilometersRange:
      pseudorangeKilometers.length > 0
        ? { minimum: Math.min(...pseudorangeKilometers), maximum: Math.max(...pseudorangeKilometers) }
        : null,
    pseudorangeMetersBySignal,
  };
}

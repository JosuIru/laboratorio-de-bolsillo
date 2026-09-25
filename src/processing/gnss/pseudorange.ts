import type { ConstellationId } from './constellations';

/**
 * Pseudodistancias a partir de las medidas crudas de Android (`GnssMeasurement`).
 *
 * pseudodistancia = c · (t_recepción − t_transmisión)
 *
 * - t_transmisión es `receivedSvTimeNanos`, en la escala de tiempo de la constelación.
 * - t_recepción sale del reloj del receptor: `timeNanos − (fullBiasNanos + biasNanos)` es el tiempo
 *   GPS en nanosegundos. Ese número (~1,4·10¹⁸) no cabe con precisión en un double de JS, así que el
 *   módulo nativo hace la resta con enteros de 64 bits y entrega solo el tiempo de la semana GPS
 *   (`receiverTimeOfWeekNanos`, < 6,05·10¹⁴ ns, que sí cabe con precisión de nanosegundo).
 *
 * Solo se calcula cuando el chip ha decodificado el tiempo de la semana (TOW) del satélite; si no,
 * `receivedSvTimeNanos` es ambiguo (solo conoce el código, 1 ms) y no hay pseudodistancia completa.
 * GLONASS (tiempo del día en otra escala) y SBAS no se calculan aquí.
 */

export const speedOfLightMetersPerSecond = 299_792_458;
export const nanosecondsPerWeek = 604_800 * 1e9;
/** El tiempo BeiDou (BDT) va 14 s por detrás del tiempo GPS. */
export const beidouToGpsOffsetNanos = 14 * 1e9;

/** Bits de `GnssMeasurement.getState()`. */
export const measurementStateBits = {
  codeLock: 0x1,
  towDecoded: 0x8,
  towKnown: 0x4000,
} as const;

export interface RawMeasurementTiming {
  constellationId: ConstellationId;
  state: number;
  receivedSvTimeNanos: number;
  receivedSvTimeUncertaintyNanos: number;
  timeOffsetNanos: number;
}

/** Rango físico de una pseudodistancia a un satélite MEO/GEO/IGSO desde la superficie (m). */
const minimumPlausiblePseudorangeMeters = 18_000_000;
const maximumPlausiblePseudorangeMeters = 42_000_000;
/** Incertidumbre máxima del tiempo de transmisión que se acepta (1 µs ≈ 300 m). */
const maximumTimeUncertaintyNanos = 1000;

/**
 * El tiempo de la semana está resuelto (TOW decodificado o conocido). En Galileo, la
 * sincronización de página E1B solo resuelve 2 s, que no bastan para una pseudodistancia completa.
 */
export function hasTimeOfWeek(timing: Pick<RawMeasurementTiming, 'state'>): boolean {
  return (timing.state & (measurementStateBits.towDecoded | measurementStateBits.towKnown)) !== 0;
}

/**
 * Devuelve la pseudodistancia en metros, o `null` si la medida no permite calcularla o el
 * resultado no es físicamente plausible (la pseudodistancia incluye el error del reloj del
 * receptor, pero Android ya lo corrige casi del todo con `biasNanos`).
 */
export function computePseudorangeMeters(timing: RawMeasurementTiming, receiverTimeOfWeekNanos: number): number | null {
  if (!Number.isFinite(receiverTimeOfWeekNanos)) return null;
  if (!['gps', 'galileo', 'beidou', 'qzss', 'navic'].includes(timing.constellationId)) return null;
  if (!hasTimeOfWeek(timing)) return null;
  if (!(timing.receivedSvTimeUncertaintyNanos <= maximumTimeUncertaintyNanos)) return null;

  let receptionTimeNanos = receiverTimeOfWeekNanos + timing.timeOffsetNanos;
  if (timing.constellationId === 'beidou') receptionTimeNanos -= beidouToGpsOffsetNanos;

  let travelTimeNanos = receptionTimeNanos - timing.receivedSvTimeNanos;
  // Cambio de semana entre la transmisión y la recepción.
  if (travelTimeNanos > nanosecondsPerWeek / 2) travelTimeNanos -= nanosecondsPerWeek;
  if (travelTimeNanos < -nanosecondsPerWeek / 2) travelTimeNanos += nanosecondsPerWeek;

  const pseudorangeMeters = (travelTimeNanos / 1e9) * speedOfLightMetersPerSecond;
  if (pseudorangeMeters < minimumPlausiblePseudorangeMeters || pseudorangeMeters > maximumPlausiblePseudorangeMeters) {
    return null;
  }
  return pseudorangeMeters;
}

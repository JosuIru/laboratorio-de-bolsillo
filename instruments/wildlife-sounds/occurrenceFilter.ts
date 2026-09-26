import type { RankedClass } from './classification';
import { base64ToBytes } from './detectionLog';
import type { SoundClass } from './modelManifest';

/**
 * Filtro por lugar y época: con los registros de presencia de cada especie en una rejilla de
 * Europa y su actividad por meses (fauna-occurrence-*.json, en la release del modelo), baja la
 * puntuación de las especies que no se han visto por la zona o que casi no se oyen en este mes.
 * No quita ninguna: solo las penaliza, y el top se reordena con las puntuaciones corregidas.
 * Los sonidos generales (lluvia, perros, coches…) no se tocan. Sin React ni ficheros.
 */

// --- Penalizaciones (en unidades de logit, las mismas que la puntuación) ---

/**
 * Especie sin registros en la celda ni en sus vecinas. 4 puntos bastan para que un «probable»
 * justo (10) baje a «dudoso» (6), pero una detección muy clara (≥ 11) sigue llegando a
 * «posible»: una especie rara o de paso no desaparece del todo.
 */
export const outOfAreaPenalty = 4;
/** Especie de la zona, pero en un mes en el que apenas se registra (migradoras, invernantes). */
export const offSeasonPenalty = 2;
/**
 * Actividad del mes (0-100, relativa al mes de más registros) por debajo de la cual se considera
 * «rara en esta época». 10 = menos de la décima parte que en su mejor mes.
 */
export const offSeasonActivityThreshold = 10;

export interface OccurrenceData {
  cellSizeDegrees: number;
  latitudeMin: number;
  longitudeMin: number;
  rowCount: number;
  columnCount: number;
  /** Posición del bit de cada especie (nombre científico) en los bitsets de las celdas. */
  bitIndexBySpeciesLabel: Map<string, number>;
  /** Clave «fila_columna» → bitset. Las celdas sin clave no tienen datos. */
  cellBitsetByKey: Map<string, Uint8Array>;
  /** Actividad relativa (0-100) de enero a diciembre. */
  monthlyActivityBySpeciesLabel: Map<string, readonly number[]>;
}

export class OccurrenceFormatError extends Error {
  constructor(problem: string) {
    super(`Fichero de presencia no válido: ${problem}`);
    this.name = 'OccurrenceFormatError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requirePositiveInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new OccurrenceFormatError(`«${key}» debe ser un entero positivo`);
  }
  return value;
}

function requireFiniteNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new OccurrenceFormatError(`«${key}» debe ser un número`);
  return value;
}

/** Comprueba y tipa el JSON descargado. Lanza `OccurrenceFormatError` si no encaja. */
export function parseOccurrenceData(rawOccurrence: unknown): OccurrenceData {
  if (!isRecord(rawOccurrence)) throw new OccurrenceFormatError('no es un objeto');
  if (rawOccurrence.formatVersion !== 1) {
    throw new OccurrenceFormatError(`versión de formato ${String(rawOccurrence.formatVersion)} no admitida`);
  }
  const cellSizeDegrees = requireFiniteNumber(rawOccurrence, 'cellSizeDegrees');
  if (cellSizeDegrees <= 0) throw new OccurrenceFormatError('«cellSizeDegrees» debe ser positivo');
  const rawSpeciesLabels = rawOccurrence.speciesLabels;
  if (!Array.isArray(rawSpeciesLabels) || !rawSpeciesLabels.every((label) => typeof label === 'string')) {
    throw new OccurrenceFormatError('«speciesLabels» debe ser una lista de textos');
  }
  const bitIndexBySpeciesLabel = new Map<string, number>();
  (rawSpeciesLabels as string[]).forEach((label, bitIndex) => bitIndexBySpeciesLabel.set(label, bitIndex));

  const rawCells = rawOccurrence.cells;
  if (!isRecord(rawCells)) throw new OccurrenceFormatError('faltan las celdas');
  const cellBitsetByKey = new Map<string, Uint8Array>();
  for (const [cellKey, encodedBitset] of Object.entries(rawCells)) {
    if (!/^\d+_\d+$/.test(cellKey) || typeof encodedBitset !== 'string') {
      throw new OccurrenceFormatError(`celda «${cellKey}» mal formada`);
    }
    try {
      cellBitsetByKey.set(cellKey, base64ToBytes(encodedBitset));
    } catch {
      throw new OccurrenceFormatError(`la celda «${cellKey}» no está en base64`);
    }
  }

  const monthlyActivityBySpeciesLabel = new Map<string, readonly number[]>();
  const rawMonthlyActivity = rawOccurrence.monthlyActivity;
  if (isRecord(rawMonthlyActivity)) {
    for (const [speciesLabel, rawMonthValues] of Object.entries(rawMonthlyActivity)) {
      // Una especie con la actividad mal escrita se queda sin filtro de época; no invalida el resto.
      if (
        Array.isArray(rawMonthValues) &&
        rawMonthValues.length === 12 &&
        rawMonthValues.every((monthValue) => typeof monthValue === 'number' && Number.isFinite(monthValue))
      ) {
        monthlyActivityBySpeciesLabel.set(speciesLabel, rawMonthValues as number[]);
      }
    }
  }

  return {
    cellSizeDegrees,
    latitudeMin: requireFiniteNumber(rawOccurrence, 'latitudeMin'),
    longitudeMin: requireFiniteNumber(rawOccurrence, 'longitudeMin'),
    rowCount: requirePositiveInteger(rawOccurrence, 'rows'),
    columnCount: requirePositiveInteger(rawOccurrence, 'columns'),
    bitIndexBySpeciesLabel,
    cellBitsetByKey,
    monthlyActivityBySpeciesLabel,
  };
}

/** Clave «fila_columna» de la celda que contiene el punto, o `null` si cae fuera de la rejilla. */
export function gridCellKeyFor(occurrenceData: OccurrenceData, latitude: number, longitude: number): string | null {
  const rowIndex = Math.floor((latitude - occurrenceData.latitudeMin) / occurrenceData.cellSizeDegrees);
  const columnIndex = Math.floor((longitude - occurrenceData.longitudeMin) / occurrenceData.cellSizeDegrees);
  if (!Number.isFinite(rowIndex) || !Number.isFinite(columnIndex)) return null;
  if (rowIndex < 0 || rowIndex >= occurrenceData.rowCount) return null;
  if (columnIndex < 0 || columnIndex >= occurrenceData.columnCount) return null;
  return `${rowIndex}_${columnIndex}`;
}

/** Dónde y cuándo se escucha, ya resuelto contra la rejilla. */
export type OccurrenceContext =
  | { status: 'active'; cellKey: string; cellBitset: Uint8Array; monthIndex: number }
  | { status: 'outside-grid' }
  | { status: 'no-cell-data' };

/** `monthIndex`: 0 = enero … 11 = diciembre (como `Date.getMonth()`). */
export function occurrenceContextFor(
  occurrenceData: OccurrenceData,
  latitude: number,
  longitude: number,
  monthIndex: number,
): OccurrenceContext {
  const cellKey = gridCellKeyFor(occurrenceData, latitude, longitude);
  if (cellKey === null) return { status: 'outside-grid' };
  const cellBitset = occurrenceData.cellBitsetByKey.get(cellKey);
  if (!cellBitset) return { status: 'no-cell-data' };
  return { status: 'active', cellKey, cellBitset, monthIndex };
}

export interface SpeciesPlausibility {
  /** Sin registros en la celda ni en sus vecinas. */
  isUnlikelyHere: boolean;
  /** Actividad del mes por debajo de `offSeasonActivityThreshold`. */
  isOffSeason: boolean;
}

const plausibleSpecies: SpeciesPlausibility = { isUnlikelyHere: false, isOffSeason: false };

function isBitSet(bitset: Uint8Array, bitIndex: number): boolean {
  const byteValue = bitset[bitIndex >> 3];
  // Un bitset más corto que la lista de especies: los bits que faltan cuentan como 0.
  return byteValue !== undefined && (byteValue & (1 << (bitIndex & 7))) !== 0;
}

/**
 * Cómo de plausible es oír esta especie aquí y ahora. Una especie que no está en el fichero no
 * se juzga (no hay datos para decir que no está).
 */
export function speciesPlausibility(
  occurrenceData: OccurrenceData,
  occurrenceContext: OccurrenceContext,
  speciesLabel: string,
): SpeciesPlausibility {
  if (occurrenceContext.status !== 'active') return plausibleSpecies;
  const bitIndex = occurrenceData.bitIndexBySpeciesLabel.get(speciesLabel);
  const isUnlikelyHere = bitIndex !== undefined && !isBitSet(occurrenceContext.cellBitset, bitIndex);
  const monthlyActivity = occurrenceData.monthlyActivityBySpeciesLabel.get(speciesLabel);
  const monthActivity = monthlyActivity?.[occurrenceContext.monthIndex];
  const isOffSeason = monthActivity !== undefined && monthActivity < offSeasonActivityThreshold;
  return { isUnlikelyHere, isOffSeason };
}

export function plausibilityPenalty(plausibility: SpeciesPlausibility): number {
  return (plausibility.isUnlikelyHere ? outOfAreaPenalty : 0) + (plausibility.isOffSeason ? offSeasonPenalty : 0);
}

/** Penalización de cada clase del modelo (mismo orden que los logits). */
export interface ClassPenalties {
  penaltyByClassIndex: Float32Array;
  plausibilityByClassIndex: Map<number, SpeciesPlausibility>;
  penalizedClassCount: number;
}

/**
 * Calcula de una vez la penalización de las 1226 clases para un lugar y un mes (se recalcula
 * solo cuando cambian), así cada ventana solo tiene que restar.
 */
export function computeClassPenalties(
  occurrenceData: OccurrenceData,
  occurrenceContext: OccurrenceContext,
  classes: readonly SoundClass[],
): ClassPenalties {
  const penaltyByClassIndex = new Float32Array(classes.length);
  const plausibilityByClassIndex = new Map<number, SpeciesPlausibility>();
  classes.forEach((soundClass, classIndex) => {
    if (soundClass.kind !== 'species') return;
    const plausibility = speciesPlausibility(occurrenceData, occurrenceContext, soundClass.label);
    const penalty = plausibilityPenalty(plausibility);
    if (penalty === 0) return;
    penaltyByClassIndex[classIndex] = penalty;
    plausibilityByClassIndex.set(classIndex, plausibility);
  });
  return { penaltyByClassIndex, plausibilityByClassIndex, penalizedClassCount: plausibilityByClassIndex.size };
}

/** Clase del top con la puntuación corregida (`score`) y la del modelo (`rawScore`). */
export interface AdjustedRankedClass extends RankedClass {
  rawScore: number;
  /** Solo en las especies penalizadas. */
  plausibility?: SpeciesPlausibility;
}

/**
 * Las `resultCount` mejores clases tras restar las penalizaciones. Con `classPenalties = null`
 * (filtro apagado) es igual que ordenar por la puntuación del modelo.
 */
export function rankClassesWithPenalties(
  logits: ArrayLike<number>,
  classPenalties: ClassPenalties | null,
  resultCount: number,
): AdjustedRankedClass[] {
  if (resultCount <= 0) return [];
  const adjustedScores = Float32Array.from(logits);
  if (classPenalties) {
    for (let classIndex = 0; classIndex < adjustedScores.length; classIndex++) {
      adjustedScores[classIndex]! -= classPenalties.penaltyByClassIndex[classIndex] ?? 0;
    }
  }
  const rankedClasses: AdjustedRankedClass[] = [];
  // Selección parcial: basta con recorrer una vez y mantener las mejores `resultCount`.
  for (let classIndex = 0; classIndex < adjustedScores.length; classIndex++) {
    const adjustedScore = adjustedScores[classIndex]!;
    if (!Number.isFinite(adjustedScore)) continue;
    if (rankedClasses.length === resultCount && adjustedScore <= rankedClasses[rankedClasses.length - 1]!.score) continue;
    const plausibility = classPenalties?.plausibilityByClassIndex.get(classIndex);
    const rankedClass: AdjustedRankedClass = { classIndex, score: adjustedScore, rawScore: logits[classIndex]! };
    if (plausibility) rankedClass.plausibility = plausibility;
    if (rankedClasses.length === resultCount) rankedClasses.pop();
    rankedClasses.push(rankedClass);
    rankedClasses.sort((left, right) => right.score - left.score);
  }
  return rankedClasses;
}

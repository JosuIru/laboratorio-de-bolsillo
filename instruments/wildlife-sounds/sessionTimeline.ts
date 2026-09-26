import { possibleMinimumScore, type RankedClass } from './classification';
import type { SoundClass } from './modelManifest';

/**
 * Lista de la sesión y línea de tiempo: qué se ha oído desde que se pulsó «Empezar», cuántas
 * veces y cuándo. Se acumula en memoria (no hace falta leer la base de datos) y aquí solo hay
 * agregación pura, sin React.
 */

/** Una especie (o clase propia) oída en una ventana. Una ventana puede dar varias. */
export interface SessionDetection {
  /** Nombre científico o, en clases propias, el nombre que les dio el usuario. */
  label: string;
  isCustomClass: boolean;
  /** Final de la ventana (epoch ms). */
  timestamp: number;
  /** Puntuación corregida (especies) o similitud (clases propias). */
  score: number;
}

/** Tope de detecciones en memoria: ≈10 h a una ventana cada 2,5 s con varias especies. */
export const maximumSessionDetections = 20_000;

/** Añade las detecciones de una ventana sin pasar del tope (se descartan las más antiguas). */
export function appendSessionDetections(
  previousDetections: readonly SessionDetection[],
  newDetections: readonly SessionDetection[],
): SessionDetection[] {
  if (newDetections.length === 0) return previousDetections as SessionDetection[];
  const combinedDetections = [...previousDetections, ...newDetections];
  return combinedDetections.length > maximumSessionDetections
    ? combinedDetections.slice(combinedDetections.length - maximumSessionDetections)
    : combinedDetections;
}

/**
 * Detecciones de una ventana: las especies del top que llegan a «posible» (con la puntuación ya
 * corregida por el filtro de lugar y época) y las clases propias reconocidas. Las ventanas con
 * voz humana no cuentan (se pasan `humanVoice = true`).
 */
export function sessionDetectionsForWindow(
  topClasses: readonly RankedClass[],
  classes: readonly SoundClass[],
  matchedCustomClassNames: readonly { name: string; similarity: number }[],
  windowEndTimestamp: number,
  hasHumanVoice: boolean,
): SessionDetection[] {
  if (hasHumanVoice) return [];
  const windowDetections: SessionDetection[] = [];
  for (const rankedClass of topClasses) {
    const soundClass = classes[rankedClass.classIndex];
    if (soundClass?.kind !== 'species' || rankedClass.score < possibleMinimumScore) continue;
    windowDetections.push({ label: soundClass.label, isCustomClass: false, timestamp: windowEndTimestamp, score: rankedClass.score });
  }
  for (const customMatch of matchedCustomClassNames) {
    windowDetections.push({
      label: customMatch.name,
      isCustomClass: true,
      timestamp: windowEndTimestamp,
      score: customMatch.similarity,
    });
  }
  return windowDetections;
}

/** Clave de agrupación: una clase propia puede llamarse igual que una especie. */
export function sessionEntryKey(detection: Pick<SessionDetection, 'label' | 'isCustomClass'>): string {
  return `${detection.isCustomClass ? 'custom' : 'species'}:${detection.label}`;
}

export interface SessionSpeciesEntry {
  key: string;
  label: string;
  isCustomClass: boolean;
  detectionCount: number;
  firstTimestamp: number;
  lastTimestamp: number;
  bestScore: number;
}

export type SessionListOrder = 'by-time' | 'by-count';

/**
 * Una fila por especie. `by-time`: por la primera vez que se oyó (como una lista de campo);
 * `by-count`: de más a menos detecciones. Los empates se deshacen por la otra ordenación.
 */
export function aggregateSessionSpecies(
  detections: readonly SessionDetection[],
  listOrder: SessionListOrder,
): SessionSpeciesEntry[] {
  const entryByKey = new Map<string, SessionSpeciesEntry>();
  for (const detection of detections) {
    const entryKey = sessionEntryKey(detection);
    const existingEntry = entryByKey.get(entryKey);
    if (!existingEntry) {
      entryByKey.set(entryKey, {
        key: entryKey,
        label: detection.label,
        isCustomClass: detection.isCustomClass,
        detectionCount: 1,
        firstTimestamp: detection.timestamp,
        lastTimestamp: detection.timestamp,
        bestScore: detection.score,
      });
      continue;
    }
    existingEntry.detectionCount++;
    existingEntry.firstTimestamp = Math.min(existingEntry.firstTimestamp, detection.timestamp);
    existingEntry.lastTimestamp = Math.max(existingEntry.lastTimestamp, detection.timestamp);
    existingEntry.bestScore = Math.max(existingEntry.bestScore, detection.score);
  }
  const byTime = (left: SessionSpeciesEntry, right: SessionSpeciesEntry) => left.firstTimestamp - right.firstTimestamp;
  const byCount = (left: SessionSpeciesEntry, right: SessionSpeciesEntry) => right.detectionCount - left.detectionCount;
  return [...entryByKey.values()].sort((left, right) =>
    listOrder === 'by-time'
      ? byTime(left, right) || byCount(left, right) || left.label.localeCompare(right.label)
      : byCount(left, right) || byTime(left, right) || left.label.localeCompare(right.label),
  );
}

// --- Línea de tiempo ---

/** Columnas de la tira: las detecciones se agrupan en tramos para no pintar miles de marcas. */
export const timelineBinCount = 120;
/** Especies que se muestran (las más frecuentes). */
export const timelineMaximumRows = 8;

export interface TimelineMark {
  /** Posición del centro del tramo, de 0 (inicio de la sesión) a 1 (final). */
  positionFraction: number;
  /** Detecciones en el tramo (para la intensidad de la marca). */
  detectionCount: number;
}

export interface TimelineRow {
  key: string;
  label: string;
  isCustomClass: boolean;
  totalDetectionCount: number;
  marks: TimelineMark[];
}

export interface SessionTimeline {
  startTimestamp: number;
  endTimestamp: number;
  rows: TimelineRow[];
  /** Especies que no caben en la tira. */
  hiddenSpeciesCount: number;
}

/**
 * Tira de la sesión entre `startTimestamp` y `endTimestamp`: una fila por especie (las
 * `maximumRows` más frecuentes) con una marca por cada tramo en el que se oyó.
 */
export function buildSessionTimeline(
  detections: readonly SessionDetection[],
  startTimestamp: number,
  endTimestamp: number,
  maximumRows: number = timelineMaximumRows,
  binCount: number = timelineBinCount,
): SessionTimeline {
  const entries = aggregateSessionSpecies(detections, 'by-count');
  const shownEntries = entries.slice(0, Math.max(0, maximumRows));
  // Una sesión de duración nula (una sola ventana) se trata como de 1 s para no dividir por 0.
  const durationMilliseconds = Math.max(1000, endTimestamp - startTimestamp);
  const binCountsByKey = new Map<string, Uint32Array>(shownEntries.map((entry) => [entry.key, new Uint32Array(binCount)]));
  for (const detection of detections) {
    const binCounts = binCountsByKey.get(sessionEntryKey(detection));
    if (!binCounts) continue;
    const timeFraction = (detection.timestamp - startTimestamp) / durationMilliseconds;
    const binIndex = Math.min(binCount - 1, Math.max(0, Math.floor(timeFraction * binCount)));
    binCounts[binIndex]!++;
  }
  const rows = shownEntries.map((entry): TimelineRow => {
    const binCounts = binCountsByKey.get(entry.key)!;
    const marks: TimelineMark[] = [];
    binCounts.forEach((detectionCount, binIndex) => {
      if (detectionCount > 0) marks.push({ positionFraction: (binIndex + 0.5) / binCount, detectionCount });
    });
    return {
      key: entry.key,
      label: entry.label,
      isCustomClass: entry.isCustomClass,
      totalDetectionCount: entry.detectionCount,
      marks,
    };
  });
  return { startTimestamp, endTimestamp, rows, hiddenSpeciesCount: entries.length - shownEntries.length };
}

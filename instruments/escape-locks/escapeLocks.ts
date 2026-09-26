import type { NoteIndex } from '@/processing/dsp/musicalNotes';

/**
 * Cerraduras para escape rooms: cada una se abre con una acción física que miden los sensores
 * (cantar una nota, poner el móvil de una forma, acercar un imán, dar golpes). Quien monta el
 * juego encadena varias y escribe el secreto que aparece al abrirlas todas.
 */

export type PhonePose = 'face-down' | 'upright' | 'upside-down' | 'left-side' | 'right-side';

export type LockDefinition =
  | { kind: 'note'; noteIndex: NoteIndex }
  | { kind: 'pose'; pose: PhonePose }
  | { kind: 'magnet' }
  | { kind: 'knocks'; knockCount: number };

export type LockKind = LockDefinition['kind'];

export interface EscapePuzzle {
  id: string;
  name: string;
  locks: LockDefinition[];
  secret: string;
}

/** Cuánto hay que sostener la acción para que la cerradura se abra. */
export const requiredHoldSecondsByKind: Record<'note' | 'pose' | 'magnet', number> = { note: 1.5, pose: 2, magnet: 1 };
export const noteToleranceCents = 40;
/** Diferencia de campo magnético (µT) que cuenta como «imán cerca»: la Tierra da ~50 µT. */
export const magnetThresholdMicrotesla = 150;
/** Golpes: separados como mucho 1,2 s entre sí; tras 1,5 s sin golpes, la cuenta se comprueba. */
const maximumKnockGapSeconds = 1.2;
const knockSettleSeconds = 1.5;

// ── Posición del móvil ──────────────────────────────────────────────────────────────────────

/**
 * Qué posición tiene el móvil según la gravedad medida por el acelerómetro (en m/s², con los
 * ejes del dispositivo: x a la derecha, y hacia arriba de la pantalla, z saliendo de ella).
 * Null si está a medias entre dos posiciones.
 */
export function detectPhonePose(gravityX: number, gravityY: number, gravityZ: number): PhonePose | 'face-up' | null {
  const gravityMagnitude = Math.hypot(gravityX, gravityY, gravityZ);
  if (gravityMagnitude < 5) return null;
  const alignmentThreshold = 0.85 * gravityMagnitude;
  if (gravityZ < -alignmentThreshold) return 'face-down';
  if (gravityZ > alignmentThreshold) return 'face-up';
  if (gravityY > alignmentThreshold) return 'upright';
  if (gravityY < -alignmentThreshold) return 'upside-down';
  if (gravityX > alignmentThreshold) return 'left-side';
  if (gravityX < -alignmentThreshold) return 'right-side';
  return null;
}

// ── Progreso de una cerradura ───────────────────────────────────────────────────────────────

export interface LockReading {
  /** Desviación de lo que suena respecto a la nota de la cerradura (cualquier octava), o null. */
  noteCentsError: number | null;
  pose: ReturnType<typeof detectPhonePose>;
  /** Diferencia del campo magnético con el del arranque, en µT, o null sin magnetómetro. */
  magneticDeviationMicrotesla: number | null;
  /** Instantes (s) de los golpes nuevos desde la última lectura. */
  newKnockTimesSeconds: readonly number[];
  nowSeconds: number;
}

export interface LockProgress {
  heldSeconds: number;
  knockTimesSeconds: number[];
  /** Último intento de golpes que no dio la cuenta (para decirlo en pantalla). */
  lastWrongKnockCount: number | null;
  isOpen: boolean;
}

export function startLockProgress(): LockProgress {
  return { heldSeconds: 0, knockTimesSeconds: [], lastWrongKnockCount: null, isOpen: false };
}

function isHoldConditionMet(lockDefinition: LockDefinition, lockReading: LockReading): boolean {
  switch (lockDefinition.kind) {
    case 'note':
      return lockReading.noteCentsError !== null && Math.abs(lockReading.noteCentsError) <= noteToleranceCents;
    case 'pose':
      return lockReading.pose === lockDefinition.pose;
    case 'magnet':
      return (
        lockReading.magneticDeviationMicrotesla !== null &&
        lockReading.magneticDeviationMicrotesla >= magnetThresholdMicrotesla
      );
    case 'knocks':
      return false;
  }
}

/**
 * Avanza la cerradura con una lectura. Las de sostener acumulan tiempo mientras se cumple la
 * condición (y lo pierden de golpe si se suelta: en un escape room la precisión es parte del
 * reto). La de golpes cuenta una serie seguida y la comprueba cuando termina.
 */
export function advanceLock(
  lockDefinition: LockDefinition,
  lockProgress: LockProgress,
  lockReading: LockReading,
  deltaSeconds: number,
): LockProgress {
  if (lockProgress.isOpen) return lockProgress;
  if (lockDefinition.kind !== 'knocks') {
    const heldSeconds = isHoldConditionMet(lockDefinition, lockReading) ? lockProgress.heldSeconds + deltaSeconds : 0;
    return { ...lockProgress, heldSeconds, isOpen: heldSeconds >= requiredHoldSecondsByKind[lockDefinition.kind] };
  }

  let knockTimesSeconds = [...lockProgress.knockTimesSeconds];
  for (const knockTimeSeconds of lockReading.newKnockTimesSeconds) {
    const previousKnockSeconds = knockTimesSeconds[knockTimesSeconds.length - 1];
    // Un golpe tras una pausa larga empieza una serie nueva.
    if (previousKnockSeconds !== undefined && knockTimeSeconds - previousKnockSeconds > maximumKnockGapSeconds) {
      knockTimesSeconds = [];
    }
    knockTimesSeconds.push(knockTimeSeconds);
  }
  const lastKnockSeconds = knockTimesSeconds[knockTimesSeconds.length - 1];
  const isSeriesFinished =
    lastKnockSeconds !== undefined && lockReading.nowSeconds - lastKnockSeconds >= knockSettleSeconds;
  if (!isSeriesFinished) return { ...lockProgress, knockTimesSeconds };
  if (knockTimesSeconds.length === lockDefinition.knockCount) {
    return { ...lockProgress, knockTimesSeconds: [], isOpen: true, lastWrongKnockCount: null };
  }
  return { ...lockProgress, knockTimesSeconds: [], lastWrongKnockCount: knockTimesSeconds.length };
}

/** Fracción de la cerradura completada, para la barra de progreso. */
export function lockCompletion(lockDefinition: LockDefinition, lockProgress: LockProgress): number {
  if (lockProgress.isOpen) return 1;
  if (lockDefinition.kind === 'knocks')
    return Math.min(1, lockProgress.knockTimesSeconds.length / lockDefinition.knockCount);
  return Math.min(1, lockProgress.heldSeconds / requiredHoldSecondsByKind[lockDefinition.kind]);
}

// ── Detección de golpes por nivel ───────────────────────────────────────────────────────────

/**
 * Golpes en el micrófono a partir del nivel de cada trama: un golpe es una subida brusca sobre el
 * ruido reciente, y después hay que esperar un poco antes de contar el siguiente (el eco del
 * mismo golpe no cuenta).
 */
export function createKnockDetector({
  riseDecibels = 15,
  refractorySeconds = 0.15,
  backgroundFrames = 10,
}: { riseDecibels?: number; refractorySeconds?: number; backgroundFrames?: number } = {}) {
  const recentLevels: number[] = [];
  let lastKnockSeconds = Number.NEGATIVE_INFINITY;
  return {
    /** Nivel de la trama en dBFS y su instante; devuelve true si es un golpe. */
    push(levelDecibels: number, timeSeconds: number): boolean {
      const sortedLevels = [...recentLevels].sort((leftLevel, rightLevel) => leftLevel - rightLevel);
      const backgroundLevel =
        sortedLevels.length > 0 ? sortedLevels[Math.floor(sortedLevels.length / 2)]! : levelDecibels;
      recentLevels.push(levelDecibels);
      if (recentLevels.length > backgroundFrames) recentLevels.shift();
      const isKnock =
        recentLevels.length > 2 &&
        levelDecibels - backgroundLevel >= riseDecibels &&
        timeSeconds - lastKnockSeconds >= refractorySeconds;
      if (isKnock) lastKnockSeconds = timeSeconds;
      return isKnock;
    },
  };
}

// ── Guardado de los puzles ──────────────────────────────────────────────────────────────────

const phonePoses: readonly PhonePose[] = ['face-down', 'upright', 'upside-down', 'left-side', 'right-side'];
export const maximumKnockCount = 9;

function parseLockDefinition(candidateLock: unknown): LockDefinition[] {
  if (typeof candidateLock !== 'object' || candidateLock === null) return [];
  const lockFields = candidateLock as Record<string, unknown>;
  switch (lockFields.kind) {
    case 'note':
      return typeof lockFields.noteIndex === 'number' &&
        Number.isInteger(lockFields.noteIndex) &&
        lockFields.noteIndex >= 0 &&
        lockFields.noteIndex < 12
        ? [{ kind: 'note', noteIndex: lockFields.noteIndex as NoteIndex }]
        : [];
    case 'pose':
      return phonePoses.includes(lockFields.pose as PhonePose)
        ? [{ kind: 'pose', pose: lockFields.pose as PhonePose }]
        : [];
    case 'magnet':
      return [{ kind: 'magnet' }];
    case 'knocks':
      return typeof lockFields.knockCount === 'number' &&
        Number.isInteger(lockFields.knockCount) &&
        lockFields.knockCount >= 1 &&
        lockFields.knockCount <= maximumKnockCount
        ? [{ kind: 'knocks', knockCount: lockFields.knockCount }]
        : [];
    default:
      return [];
  }
}

/** Descarta lo corrupto en lugar de fallar: los datos vienen del almacenamiento local. */
export function parseStoredPuzzles(storedText: string | null): EscapePuzzle[] {
  if (!storedText) return [];
  try {
    const parsedValue: unknown = JSON.parse(storedText);
    if (!Array.isArray(parsedValue)) return [];
    return parsedValue.flatMap((candidatePuzzle): EscapePuzzle[] => {
      if (typeof candidatePuzzle !== 'object' || candidatePuzzle === null) return [];
      const { id, name, locks, secret } = candidatePuzzle as Record<string, unknown>;
      if (typeof id !== 'string' || typeof name !== 'string' || typeof secret !== 'string' || !Array.isArray(locks))
        return [];
      const validLocks = locks.flatMap(parseLockDefinition);
      return validLocks.length > 0 ? [{ id, name, secret, locks: validLocks }] : [];
    });
  } catch {
    return [];
  }
}

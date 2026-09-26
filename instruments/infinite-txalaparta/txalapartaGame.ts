import { createSeededRandom } from '@/processing/dsp/signalGenerator';

/**
 * Txalaparta sin fin: como en la txalaparta de verdad, dos partes se alternan. El móvil toca una
 * (el «ttakun») y quien juega rellena los huecos con palmadas o golpes en la mesa. Cada compás
 * tiene 8 corcheas; el tempo sube poco a poco y los patrones se complican, hasta fallar tres
 * seguidas.
 */

export type SlotOwner = 'machine' | 'player' | 'rest';

export const slotsPerBar = 8;
export const startBeatsPerMinute = 76;
export const maximumBeatsPerMinute = 150;
/** Cada cuántos compases sube el tempo y cuánto. */
const barsPerTempoStep = 4;
const tempoStepBeatsPerMinute = 4;
/** Cada cuántos compases entra un nivel de patrones más difícil. */
const barsPerLevel = 8;
export const missesToLose = 3;

/** Patrones por nivel: M = móvil, P = jugador, - = silencio. */
const patternsByLevel: readonly (readonly string[])[] = [
  ['MPMPMPMP'],
  ['MPMPMPMP', 'MMPPMMPP', 'MPMP-PMP'],
  ['MMPPMMPP', 'MP-PMPMP', 'MPPMMPPM', 'M-PPM-PP'],
  ['MPPMMPPM', 'M-PPM-PP', 'MMP-MMP-', 'MP-PPMP-', 'MPPPMPPP'],
];

function patternToOwners(pattern: string): SlotOwner[] {
  return [...pattern].map((symbol) => (symbol === 'M' ? 'machine' : symbol === 'P' ? 'player' : 'rest'));
}

export function levelForBar(barIndex: number): number {
  return Math.min(patternsByLevel.length - 1, Math.floor(barIndex / barsPerLevel));
}

export function beatsPerMinuteForBar(barIndex: number): number {
  return Math.min(maximumBeatsPerMinute, startBeatsPerMinute + tempoStepBeatsPerMinute * Math.floor(barIndex / barsPerTempoStep));
}

/** Duración de una corchea a un tempo (negras por minuto). */
export function eighthSeconds(beatsPerMinute: number): number {
  return 60 / beatsPerMinute / 2;
}

/** Los dos primeros compases son siempre el patrón básico, para entrar en el juego. */
export function generateBar(barIndex: number, seed: number): SlotOwner[] {
  if (barIndex < 2) return patternToOwners(patternsByLevel[0]![0]!);
  const levelPatterns = patternsByLevel[levelForBar(barIndex)]!;
  const nextRandom = createSeededRandom(seed * 7919 + barIndex);
  return patternToOwners(levelPatterns[Math.floor(nextRandom() * levelPatterns.length)]!);
}

// ── Juicio de las palmadas ──────────────────────────────────────────────────────────────────

/** Golpes del micrófono a menos de esto de un golpe del móvil se atribuyen al móvil. */
export const machineExclusionSeconds = 0.05;

export interface SlotJudgement {
  isHit: boolean;
  /** Adelanto (−) o retraso (+) de la palmada respecto a su sitio, en segundos. */
  errorSeconds: number | null;
}

/**
 * ¿Hubo una palmada en su sitio? Se busca el golpe más cercano dentro de la tolerancia que no sea
 * un golpe del propio móvil (los del altavoz también llegan al micrófono).
 */
export function judgePlayerSlot(
  expectedMicrophoneSeconds: number,
  onsetTimesSeconds: readonly number[],
  machineMicrophoneTimesSeconds: readonly number[],
  toleranceSeconds: number,
): SlotJudgement {
  let bestErrorSeconds: number | null = null;
  for (const onsetTimeSeconds of onsetTimesSeconds) {
    const errorSeconds = onsetTimeSeconds - expectedMicrophoneSeconds;
    if (Math.abs(errorSeconds) > toleranceSeconds) continue;
    const isMachineStroke = machineMicrophoneTimesSeconds.some(
      (machineTimeSeconds) => Math.abs(machineTimeSeconds - onsetTimeSeconds) <= machineExclusionSeconds,
    );
    if (isMachineStroke) continue;
    if (bestErrorSeconds === null || Math.abs(errorSeconds) < Math.abs(bestErrorSeconds)) bestErrorSeconds = errorSeconds;
  }
  return { isHit: bestErrorSeconds !== null, errorSeconds: bestErrorSeconds };
}

/** Tolerancia de una palmada: un 30 % de la corchea, entre 60 y 110 ms. */
export function toleranceForTempo(beatsPerMinute: number): number {
  return Math.min(0.11, Math.max(0.06, 0.3 * eighthSeconds(beatsPerMinute)));
}

export interface GameTally {
  hits: number;
  misses: number;
  consecutiveMisses: number;
  /** Suma de |error| de los aciertos, para la precisión media. */
  absoluteErrorSumSeconds: number;
  isOver: boolean;
}

export const emptyTally: GameTally = { hits: 0, misses: 0, consecutiveMisses: 0, absoluteErrorSumSeconds: 0, isOver: false };

export function addJudgement(gameTally: GameTally, slotJudgement: SlotJudgement): GameTally {
  if (gameTally.isOver) return gameTally;
  if (slotJudgement.isHit) {
    return {
      ...gameTally,
      hits: gameTally.hits + 1,
      consecutiveMisses: 0,
      absoluteErrorSumSeconds: gameTally.absoluteErrorSumSeconds + Math.abs(slotJudgement.errorSeconds ?? 0),
    };
  }
  const consecutiveMisses = gameTally.consecutiveMisses + 1;
  return { ...gameTally, misses: gameTally.misses + 1, consecutiveMisses, isOver: consecutiveMisses >= missesToLose };
}

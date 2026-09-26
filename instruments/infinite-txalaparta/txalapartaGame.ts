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
/** Lo que dura el golpe de madera del móvil: lo que se oiga mientras suena también es suyo. */
export const machineStrokeSeconds = 0.14;

export interface SlotJudgement {
  isHit: boolean;
  /** Adelanto (−) o retraso (+) de la palmada respecto a su sitio, en segundos. */
  errorSeconds: number | null;
  /** Falta: un golpe en un silencio o en el hueco del móvil. */
  isStray?: boolean;
}

export const strayJudgement: SlotJudgement = { isHit: false, errorSeconds: null, isStray: true };

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

/**
 * ¿Golpeó quien juega donde no le tocaba (un silencio o el hueco del móvil)? Cuenta cualquier
 * golpe dentro de la tolerancia del sitio, salvo los que caen mientras suena un golpe del móvil
 * (desde un poco antes hasta que se apaga): esos pueden ser el propio altavoz. Una palmada justo
 * a la vez que el móvil no se puede distinguir de su golpe y no cuenta.
 */
export function detectStrayStroke(
  expectedMicrophoneSeconds: number,
  onsetTimesSeconds: readonly number[],
  machineMicrophoneTimesSeconds: readonly number[],
  toleranceSeconds: number,
): boolean {
  return onsetTimesSeconds.some((onsetTimeSeconds) => {
    if (Math.abs(onsetTimeSeconds - expectedMicrophoneSeconds) > toleranceSeconds) return false;
    const isDuringMachineStroke = machineMicrophoneTimesSeconds.some(
      (machineTimeSeconds) =>
        onsetTimeSeconds >= machineTimeSeconds - machineExclusionSeconds &&
        onsetTimeSeconds <= machineTimeSeconds + machineStrokeSeconds,
    );
    return !isDuringMachineStroke;
  });
}

/** Tolerancia de una palmada: un 30 % de la corchea, entre 60 y 110 ms. */
export function toleranceForTempo(beatsPerMinute: number): number {
  return Math.min(0.11, Math.max(0.06, 0.3 * eighthSeconds(beatsPerMinute)));
}

/** Aciertos seguidos, sin faltas ni fallos, que devuelven una vida perdida por una falta. */
export const cleanHitsToForgiveStray = 8;

export interface GameTally {
  hits: number;
  /** Fallos, faltas incluidas. */
  misses: number;
  /** Faltas: golpes en silencios o en el hueco del móvil. */
  strayStrokes: number;
  /**
   * Vidas perdidas: los fallos seguidos más las faltas aún no perdonadas. Un acierto borra los
   * fallos, pero una falta solo se perdona tras varios aciertos limpios seguidos: así golpear en
   * todas las corcheas no sale gratis.
   */
  consecutiveMisses: number;
  /** Faltas que aún cuestan una vida. */
  unforgivenStrays: number;
  /** Aciertos seguidos desde la última falta o fallo. */
  cleanHitStreak: number;
  /** Suma de |error| de los aciertos, para la precisión media. */
  absoluteErrorSumSeconds: number;
  isOver: boolean;
}

export const emptyTally: GameTally = {
  hits: 0,
  misses: 0,
  strayStrokes: 0,
  consecutiveMisses: 0,
  unforgivenStrays: 0,
  cleanHitStreak: 0,
  absoluteErrorSumSeconds: 0,
  isOver: false,
};

export function addJudgement(gameTally: GameTally, slotJudgement: SlotJudgement): GameTally {
  if (gameTally.isOver) return gameTally;
  if (slotJudgement.isHit) {
    const isStrayForgiven =
      gameTally.unforgivenStrays > 0 && gameTally.cleanHitStreak + 1 >= cleanHitsToForgiveStray;
    const unforgivenStrays = gameTally.unforgivenStrays - (isStrayForgiven ? 1 : 0);
    return {
      ...gameTally,
      hits: gameTally.hits + 1,
      consecutiveMisses: unforgivenStrays,
      unforgivenStrays,
      cleanHitStreak: isStrayForgiven ? 0 : gameTally.cleanHitStreak + 1,
      absoluteErrorSumSeconds: gameTally.absoluteErrorSumSeconds + Math.abs(slotJudgement.errorSeconds ?? 0),
    };
  }
  const isStray = slotJudgement.isStray === true;
  const consecutiveMisses = gameTally.consecutiveMisses + 1;
  return {
    ...gameTally,
    misses: gameTally.misses + 1,
    strayStrokes: gameTally.strayStrokes + (isStray ? 1 : 0),
    consecutiveMisses,
    unforgivenStrays: gameTally.unforgivenStrays + (isStray ? 1 : 0),
    cleanHitStreak: 0,
    isOver: consecutiveMisses >= missesToLose,
  };
}

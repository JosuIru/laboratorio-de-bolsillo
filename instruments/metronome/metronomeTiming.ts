/**
 * Cálculos de tiempo del metrónomo, sin audio ni React: límites del tempo, tempo a partir de
 * toques en pantalla y reparto de pulsos en el reloj de audio.
 */

export const minimumBeatsPerMinute = 30;
export const maximumBeatsPerMinute = 250;
/** Toques recientes con los que se calcula el tempo marcado a mano. */
const tapHistoryLength = 8;
/** Una pausa más larga que esta empieza una serie nueva de toques. */
export const tapResetSeconds = 2;

export function clampBeatsPerMinute(beatsPerMinute: number): number {
  const roundedBeatsPerMinute = Math.round(beatsPerMinute);
  return Math.min(maximumBeatsPerMinute, Math.max(minimumBeatsPerMinute, roundedBeatsPerMinute));
}

/** Añade un toque y descarta la serie anterior si la pausa ha sido larga. */
export function appendTap(previousTapTimesSeconds: readonly number[], tapTimeSeconds: number): number[] {
  const lastTapTimeSeconds = previousTapTimesSeconds[previousTapTimesSeconds.length - 1];
  if (lastTapTimeSeconds === undefined || tapTimeSeconds - lastTapTimeSeconds > tapResetSeconds) {
    return [tapTimeSeconds];
  }
  return [...previousTapTimesSeconds, tapTimeSeconds].slice(-tapHistoryLength);
}

/**
 * Tempo de una serie de toques: mediana de los intervalos, para que un toque torpe no lo mueva.
 * Devuelve null si aún no hay dos toques.
 */
export function beatsPerMinuteFromTaps(tapTimesSeconds: readonly number[]): number | null {
  if (tapTimesSeconds.length < 2) return null;
  const tapIntervalsSeconds = tapTimesSeconds
    .slice(1)
    .map((tapTimeSeconds, intervalIndex) => tapTimeSeconds - (tapTimesSeconds[intervalIndex] ?? tapTimeSeconds))
    .sort((firstInterval, secondInterval) => firstInterval - secondInterval);
  const middleIndex = Math.floor(tapIntervalsSeconds.length / 2);
  const medianIntervalSeconds =
    tapIntervalsSeconds.length % 2 === 1
      ? (tapIntervalsSeconds[middleIndex] ?? 0)
      : ((tapIntervalsSeconds[middleIndex - 1] ?? 0) + (tapIntervalsSeconds[middleIndex] ?? 0)) / 2;
  if (medianIntervalSeconds <= 0) return null;
  return clampBeatsPerMinute(60 / medianIntervalSeconds);
}

export interface ScheduledBeat {
  /** Instante en el reloj de audio. */
  timeSeconds: number;
  /** Posición en el compás, desde 0. */
  beatInBar: number;
  isAccent: boolean;
}

export interface BeatSchedulerPosition {
  nextBeatTimeSeconds: number;
  nextBeatInBar: number;
}

/**
 * Pulsos que caen antes de `horizonSeconds` a partir de la posición actual. El tempo y el
 * compás se leen en cada llamada, así que un cambio se nota en el pulso siguiente.
 */
export function scheduleBeatsUntil(
  position: BeatSchedulerPosition,
  horizonSeconds: number,
  beatsPerMinute: number,
  beatsPerBar: number,
): { scheduledBeats: ScheduledBeat[]; nextPosition: BeatSchedulerPosition } {
  const periodSeconds = 60 / clampBeatsPerMinute(beatsPerMinute);
  const scheduledBeats: ScheduledBeat[] = [];
  let { nextBeatTimeSeconds, nextBeatInBar } = position;
  // Si el compás se ha acortado, el pulso siguiente vuelve al principio.
  if (nextBeatInBar >= beatsPerBar) nextBeatInBar = 0;
  while (nextBeatTimeSeconds < horizonSeconds) {
    scheduledBeats.push({
      timeSeconds: nextBeatTimeSeconds,
      beatInBar: nextBeatInBar,
      isAccent: beatsPerBar > 1 && nextBeatInBar === 0,
    });
    nextBeatTimeSeconds += periodSeconds;
    nextBeatInBar = (nextBeatInBar + 1) % beatsPerBar;
  }
  return { scheduledBeats, nextPosition: { nextBeatTimeSeconds, nextBeatInBar } };
}

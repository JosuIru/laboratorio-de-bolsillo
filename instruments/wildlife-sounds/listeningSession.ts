/**
 * Resumen de una sesión de escucha (para guardarla como medición): cuántas ventanas se han
 * analizado, cuántas se han apuntado, cuántas se han descartado por voz humana y qué especies.
 */

export interface SpeciesTally {
  label: string;
  detectionCount: number;
  bestScore: number;
}

export interface ListeningSessionSummary {
  sessionStartTimestamp: number;
  analyzedWindowCount: number;
  loggedDetectionCount: number;
  humanVoiceWindowCount: number;
  totalAnalysisMilliseconds: number;
  /** De más a menos detecciones (y, a igualdad, por mejor puntuación). */
  speciesTallies: SpeciesTally[];
}

export type WindowOutcome =
  | { kind: 'logged'; speciesLabel: string; speciesScore: number }
  | { kind: 'human-voice' }
  | { kind: 'below-threshold' };

export function createListeningSessionSummary(sessionStartTimestamp: number): ListeningSessionSummary {
  return {
    sessionStartTimestamp,
    analyzedWindowCount: 0,
    loggedDetectionCount: 0,
    humanVoiceWindowCount: 0,
    totalAnalysisMilliseconds: 0,
    speciesTallies: [],
  };
}

/** Devuelve un resumen nuevo con la ventana añadida (no modifica el anterior). */
export function addWindowToSession(
  previousSummary: ListeningSessionSummary,
  windowOutcome: WindowOutcome,
  analysisMilliseconds: number,
): ListeningSessionSummary {
  const nextSummary: ListeningSessionSummary = {
    ...previousSummary,
    analyzedWindowCount: previousSummary.analyzedWindowCount + 1,
    totalAnalysisMilliseconds: previousSummary.totalAnalysisMilliseconds + analysisMilliseconds,
  };
  if (windowOutcome.kind === 'human-voice') {
    nextSummary.humanVoiceWindowCount++;
  } else if (windowOutcome.kind === 'logged') {
    nextSummary.loggedDetectionCount++;
    const existingTally = previousSummary.speciesTallies.find((tally) => tally.label === windowOutcome.speciesLabel);
    const updatedTally: SpeciesTally = existingTally
      ? {
          label: existingTally.label,
          detectionCount: existingTally.detectionCount + 1,
          bestScore: Math.max(existingTally.bestScore, windowOutcome.speciesScore),
        }
      : { label: windowOutcome.speciesLabel, detectionCount: 1, bestScore: windowOutcome.speciesScore };
    nextSummary.speciesTallies = [
      ...previousSummary.speciesTallies.filter((tally) => tally.label !== windowOutcome.speciesLabel),
      updatedTally,
    ].sort((left, right) => right.detectionCount - left.detectionCount || right.bestScore - left.bestScore);
  }
  return nextSummary;
}

export function averageAnalysisMilliseconds(summary: ListeningSessionSummary): number {
  return summary.analyzedWindowCount > 0 ? summary.totalAnalysisMilliseconds / summary.analyzedWindowCount : 0;
}

/** «Mirlo común (Turdus merula) ×12; Petirrojo (Erithacus rubecula) ×3». */
export function formatSpeciesSummary(
  speciesTallies: readonly SpeciesTally[],
  commonNameForLabel: (label: string) => string,
): string {
  return speciesTallies
    .map((tally) => {
      const commonName = commonNameForLabel(tally.label);
      const nameText = commonName === tally.label ? tally.label : `${commonName} (${tally.label})`;
      return `${nameText} ×${tally.detectionCount}`;
    })
    .join('; ');
}

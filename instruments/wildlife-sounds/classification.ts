import type { SoundClass } from './modelManifest';

/**
 * Interpretación de las puntuaciones del modelo. Perch no da probabilidades: da logits, que en
 * los aciertos de las pruebas iban de ≈6 a ≈15. Los umbrales de aquí son a ojo, a partir de esas
 * pruebas; sirven para orientar, no son una probabilidad de acierto.
 */

/** Por debajo: «dudoso». */
export const possibleMinimumScore = 7;
/** Por encima: «probable». Entre los dos: «posible». */
export const probableMinimumScore = 10;
/** Extremos de la barra de confianza (la barra va de vacía a llena entre ellos). */
const confidenceBarEmptyScore = 3;
const confidenceBarFullScore = 15;

/** Una detección se apunta en el registro si alguna especie del top 5 llega a esto. */
export const loggingMinimumScore = possibleMinimumScore;
/**
 * Privacidad: si una clase de voz humana está entre las 3 primeras con al menos esta puntuación,
 * la detección no se guarda. Más baja que «dudoso» a propósito: mejor perder alguna detección
 * que guardar el embedding de una conversación.
 */
export const humanVoiceMinimumScore = 4;
export const humanVoiceTopCount = 3;

export type ConfidenceLevel = 'doubtful' | 'possible' | 'probable';

export interface RankedClass {
  classIndex: number;
  score: number;
}

/** Las `resultCount` clases de mayor puntuación, de mayor a menor. */
export function topScoringClasses(scores: ArrayLike<number>, resultCount: number): RankedClass[] {
  const rankedClasses: RankedClass[] = [];
  for (let classIndex = 0; classIndex < scores.length; classIndex++) {
    const score = scores[classIndex]!;
    if (!Number.isFinite(score)) continue;
    if (rankedClasses.length < resultCount) {
      rankedClasses.push({ classIndex, score });
      rankedClasses.sort((left, right) => right.score - left.score);
    } else if (score > rankedClasses[rankedClasses.length - 1]!.score) {
      rankedClasses[rankedClasses.length - 1] = { classIndex, score };
      rankedClasses.sort((left, right) => right.score - left.score);
    }
  }
  return rankedClasses;
}

export function confidenceLevelFor(score: number): ConfidenceLevel {
  if (score >= probableMinimumScore) return 'probable';
  if (score >= possibleMinimumScore) return 'possible';
  return 'doubtful';
}

/** Llenado de la barra de confianza, entre 0 y 1. */
export function confidenceBarFraction(score: number): number {
  const fraction = (score - confidenceBarEmptyScore) / (confidenceBarFullScore - confidenceBarEmptyScore);
  return Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
}

/** Idiomas de los nombres comunes, en el orden en que se prueban para cada idioma de la app. */
const nameLanguageOrderByLocale: Record<string, readonly ('es' | 'eu' | 'en')[]> = {
  es: ['es', 'eu', 'en'],
  eu: ['eu', 'es', 'en'],
};

/**
 * Nombre común en el idioma de la app; si no lo hay, en el otro idioma de la app, en inglés y,
 * como último recurso, la etiqueta (nombre científico o etiqueta de sonido con espacios).
 */
export function displayNameFor(soundClass: SoundClass, locale: string): string {
  const languageOrder = nameLanguageOrderByLocale[locale] ?? ['en', 'es', 'eu'];
  for (const language of languageOrder) {
    const commonName = soundClass.names[language];
    if (commonName) return commonName;
  }
  return soundClass.label.replace(/_/g, ' ');
}

export type LoggingDecision =
  | { kind: 'log'; speciesClassIndex: number; speciesScore: number }
  | { kind: 'human-voice' }
  | { kind: 'below-threshold' };

/**
 * Decide si una ventana analizada se apunta en el registro:
 * - no, si hay voz humana entre las primeras (privacidad), aunque también haya un pájaro;
 * - sí, si alguna especie del top llega al umbral (se apunta la mejor);
 * - no, en otro caso (solo sonidos generales o especies dudosas).
 */
export function decideDetectionLogging(
  topClasses: readonly RankedClass[],
  classes: readonly SoundClass[],
  minimumSpeciesScore: number = loggingMinimumScore,
): LoggingDecision {
  const hasHumanVoice = topClasses
    .slice(0, humanVoiceTopCount)
    .some((rankedClass) => classes[rankedClass.classIndex]?.isHumanVoice && rankedClass.score >= humanVoiceMinimumScore);
  if (hasHumanVoice) return { kind: 'human-voice' };
  const bestSpecies = topClasses.find((rankedClass) => classes[rankedClass.classIndex]?.kind === 'species');
  if (bestSpecies && bestSpecies.score >= minimumSpeciesScore) {
    return { kind: 'log', speciesClassIndex: bestSpecies.classIndex, speciesScore: bestSpecies.score };
  }
  return { kind: 'below-threshold' };
}

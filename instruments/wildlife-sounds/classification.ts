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

// --- Qué se muestra como resultado (y, por tanto, qué se apunta) ---

/**
 * Umbral absoluto: una especie por debajo de «posible» es «dudosa» y no se muestra como resultado
 * (queda en el desplegable «ver candidatas dudosas»). En las pruebas, las especies «raras» que
 * aparecían eran casi siempre dudosas.
 */
export const displayMinimumScore = possibleMinimumScore;
/**
 * Margen relativo: además, una especie solo se muestra si queda a menos de estos puntos de la
 * primera. Con una primera muy clara (14) no aparecen acompañantes de 8 o 9, que suelen ser
 * confusiones del modelo con especies parecidas; con dos especies cantando a la vez y bien
 * oídas, las dos suelen quedar a 1-2 puntos.
 */
export const relativeMarginScore = 3;
/**
 * Un sonido general (viento, coche, perro…) se menciona como «también se oye» si llega a esto.
 * Alto a propósito: es información de contexto, no el resultado.
 */
export const alsoHeardSoundMinimumScore = probableMinimumScore;
/** Una detección se apunta en el registro si la mejor especie se muestra como resultado. */
export const loggingMinimumScore = displayMinimumScore;

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
  es: ['es', 'en', 'eu'],
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

/** Reparto del top de una ventana entre lo que se muestra, lo que queda oculto y el contexto. */
export interface DisplayedResults<RankedType extends RankedClass> {
  /** Especies que pasan el umbral absoluto y el margen relativo, de mayor a menor. */
  shownSpecies: RankedType[];
  /** Especies del top que no pasan alguno de los dos criterios (ocultas por defecto). */
  doubtfulSpecies: RankedType[];
  /** Sonidos generales con puntuación alta («también se oye: …»). */
  alsoHeardSounds: RankedType[];
}

/**
 * Decide qué se muestra de un top ya ordenado de mayor a menor (con las puntuaciones corregidas
 * por el filtro de zona, si lo hay). `minimumSpeciesScore` permite otro umbral absoluto.
 */
export function selectDisplayedResults<RankedType extends RankedClass>(
  topClasses: readonly RankedType[],
  classes: readonly SoundClass[],
  minimumSpeciesScore: number = displayMinimumScore,
): DisplayedResults<RankedType> {
  const displayedResults: DisplayedResults<RankedType> = { shownSpecies: [], doubtfulSpecies: [], alsoHeardSounds: [] };
  let bestSpeciesScore: number | null = null;
  for (const rankedClass of topClasses) {
    const soundClass = classes[rankedClass.classIndex];
    if (!soundClass) continue;
    if (soundClass.kind !== 'species') {
      if (rankedClass.score >= alsoHeardSoundMinimumScore) displayedResults.alsoHeardSounds.push(rankedClass);
      continue;
    }
    bestSpeciesScore ??= rankedClass.score;
    const isAboveThreshold = rankedClass.score >= minimumSpeciesScore;
    const isWithinMargin = bestSpeciesScore - rankedClass.score < relativeMarginScore;
    if (isAboveThreshold && isWithinMargin) displayedResults.shownSpecies.push(rankedClass);
    else displayedResults.doubtfulSpecies.push(rankedClass);
  }
  return displayedResults;
}

export type LoggingDecision =
  | { kind: 'log'; speciesClassIndex: number; speciesScore: number }
  | { kind: 'human-voice' }
  | { kind: 'below-threshold' };

/**
 * Decide si una ventana analizada se apunta en el registro:
 * - no, si hay voz humana entre las primeras (privacidad), aunque también haya un pájaro;
 * - sí, si alguna especie se muestra como resultado (se apunta la mejor);
 * - no, en otro caso (solo sonidos generales o especies dudosas).
 * Como el top llega ya sin las especies excluidas por el filtro de zona, tampoco se apuntan.
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
  const bestShownSpecies = selectDisplayedResults(topClasses, classes, minimumSpeciesScore).shownSpecies[0];
  if (bestShownSpecies) {
    return { kind: 'log', speciesClassIndex: bestShownSpecies.classIndex, speciesScore: bestShownSpecies.score };
  }
  return { kind: 'below-threshold' };
}

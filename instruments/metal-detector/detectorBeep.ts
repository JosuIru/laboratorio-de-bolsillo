/**
 * Del ΔB al «calor» del pitido continuo (0 = lejos, 1 = encima del metal), para barrer sin
 * mirar la pantalla. Escala logarítmica: el campo de un imán o un clavo cae muy deprisa con la
 * distancia, y así el pitido cambia igual de notablemente a 10 cm que a 1 cm.
 */

/** Por debajo de esta fracción del umbral de aviso, el pitido va a su ritmo más lento. */
const quietFractionOfTrigger = 0.25;
/** A partir de este múltiplo del umbral, el pitido ya va a tope. */
const saturationMultipleOfTrigger = 4;

/** `null` mientras no hay lectura (p. ej. poniendo a cero): entonces el pitido calla. */
export function detectorBeepHeat(deviationMicroteslas: number | null, triggerMicroteslas: number): number | null {
  if (deviationMicroteslas === null || !Number.isFinite(deviationMicroteslas) || !(triggerMicroteslas > 0)) return null;
  const quietDeviation = triggerMicroteslas * quietFractionOfTrigger;
  const saturationDeviation = triggerMicroteslas * saturationMultipleOfTrigger;
  if (deviationMicroteslas <= quietDeviation) return 0;
  const heat = Math.log(deviationMicroteslas / quietDeviation) / Math.log(saturationDeviation / quietDeviation);
  return Math.min(1, heat);
}

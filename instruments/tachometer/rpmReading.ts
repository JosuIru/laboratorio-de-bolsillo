/**
 * Conversión de frecuencia a revoluciones por minuto y estabilización de la lectura.
 *
 * Lo que oye el micrófono es la frecuencia de los pulsos: en un ventilador de 5 aspas, cada
 * vuelta produce 5 soplidos. Por eso hay que decirle al tacómetro cuántos pulsos da cada vuelta.
 */

export const minimumPulsesPerRevolution = 1;
export const maximumPulsesPerRevolution = 12;

export function frequencyToRevolutionsPerMinute(frequencyHz: number, pulsesPerRevolution: number): number {
  if (!(Number.isInteger(pulsesPerRevolution) && pulsesPerRevolution >= minimumPulsesPerRevolution)) {
    throw new RangeError(`Los pulsos por vuelta deben ser un entero ≥ 1: ${pulsesPerRevolution}`);
  }
  return (frequencyHz * 60) / pulsesPerRevolution;
}

export function revolutionsPerMinuteToFrequency(revolutionsPerMinute: number, pulsesPerRevolution: number): number {
  return (revolutionsPerMinute * pulsesPerRevolution) / 60;
}

export interface StabilizedReading {
  /**
   * Mediana de las lecturas recientes: ignora las que salen de un golpe o una voz. Es siempre
   * una lectura real (la mediana inferior), nunca el promedio de dos: si suenan dos fuentes, el
   * promedio daría una frecuencia intermedia que no existe.
   */
  medianFrequencyHz: number;
  /** Dispersión relativa (rango intercuartílico / mediana). Bajo = régimen estable. */
  relativeSpread: number;
  isStable: boolean;
  readingCount: number;
}

export interface ReadingStabilizerOptions {
  /** Lecturas que se recuerdan (a 10 lecturas/s, 15 son 1,5 s). */
  historyLength?: number;
  /** Dispersión máxima para considerar la lectura estable. 0,01 = ±1 %. */
  stableRelativeSpread?: number;
  /** Lecturas necesarias antes de dar nada por estable. */
  minimumReadingCount?: number;
}

function quantile(sortedValues: readonly number[], fraction: number): number {
  const position = (sortedValues.length - 1) * fraction;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const interpolationWeight = position - lowerIndex;
  return sortedValues[lowerIndex]! * (1 - interpolationWeight) + sortedValues[upperIndex]! * interpolationWeight;
}

/**
 * Acumula las frecuencias detectadas y da una lectura estable. Una lectura `null` (no hay
 * tono) no borra la historia: así una tos no hace saltar la cifra, pero si el silencio dura
 * toda la historia la lectura desaparece.
 */
export function createReadingStabilizer(options: ReadingStabilizerOptions = {}) {
  const { historyLength = 15, stableRelativeSpread = 0.01, minimumReadingCount = 5 } = options;
  let recentReadings: (number | null)[] = [];

  return {
    push(frequencyHz: number | null): StabilizedReading | null {
      recentReadings = [...recentReadings, frequencyHz].slice(-historyLength);
      const validReadings = recentReadings.filter((reading): reading is number => reading !== null);
      if (validReadings.length === 0) return null;

      const sortedReadings = [...validReadings].sort((leftReading, rightReading) => leftReading - rightReading);
      const medianFrequencyHz = sortedReadings[Math.floor((sortedReadings.length - 1) / 2)]!;
      const interquartileRange = quantile(sortedReadings, 0.75) - quantile(sortedReadings, 0.25);
      const relativeSpread = medianFrequencyHz > 0 ? interquartileRange / medianFrequencyHz : Infinity;
      return {
        medianFrequencyHz,
        relativeSpread,
        isStable: validReadings.length >= minimumReadingCount && relativeSpread <= stableRelativeSpread,
        readingCount: validReadings.length,
      };
    },
    reset(): void {
      recentReadings = [];
    },
  };
}

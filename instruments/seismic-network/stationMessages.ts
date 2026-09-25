/**
 * Mensajes de estación: la forma de llevar los datos de cada móvil a la central sin red propia.
 *
 * Cada estación comparte un texto (por el chat de clase, por correo…) que lleva una línea legible
 * y una línea de código `#sismo|nombre|x|y|llegada`. En la central se pega todo lo recibido de
 * golpe y se leen las líneas de código; el resto del texto se ignora.
 */

export interface StationReading {
  stationName: string;
  xMeters: number;
  yMeters: number;
  /** Segundos desde el golpe de sincronización, en el reloj de la estación. */
  arrivalSeconds: number;
}

const messageTag = '#sismo';

/** Número con coma decimal, como se escribe en castellano y en euskera. */
export function formatDecimal(numericValue: number, fractionDigits: number): string {
  return numericValue.toFixed(fractionDigits).replace('.', ',');
}

function sanitizeStationName(stationName: string): string {
  return stationName.replace(/[|\n\r]/g, ' ').trim() || '?';
}

/** Línea de código que entiende la central. Usa punto decimal para no chocar con nada. */
export function buildStationCodeLine(stationReading: StationReading): string {
  return [
    messageTag,
    sanitizeStationName(stationReading.stationName),
    stationReading.xMeters.toFixed(3),
    stationReading.yMeters.toFixed(3),
    stationReading.arrivalSeconds.toFixed(5),
  ].join('|');
}

/** Lee todas las líneas `#sismo|…` de un texto pegado. Si un nombre se repite, gana la última. */
export function parseStationMessages(pastedText: string): StationReading[] {
  const readingsByName = new Map<string, StationReading>();
  const codeLinePattern = /#sismo\|([^|\n\r]+)\|(-?[\d.,]+)\|(-?[\d.,]+)\|(-?[\d.,]+)/g;
  for (const match of pastedText.matchAll(codeLinePattern)) {
    const [, rawName, rawX, rawY, rawArrival] = match;
    const parsedNumbers = [rawX, rawY, rawArrival].map((rawNumber) => Number(rawNumber!.replace(',', '.')));
    if (parsedNumbers.some((parsedNumber) => !Number.isFinite(parsedNumber))) continue;
    const stationName = rawName!.trim();
    readingsByName.set(stationName, {
      stationName,
      xMeters: parsedNumbers[0]!,
      yMeters: parsedNumbers[1]!,
      arrivalSeconds: parsedNumbers[2]!,
    });
  }
  return [...readingsByName.values()];
}

import { defineMeasurementSchema } from '@/core/measurements/schema';

/** Resultado de una partida de «Caza de colores». */
export interface ColorHuntMeasurementValues {
  /** Puntuación del ganador (o del único jugador). */
  winnerTotalPoints: number;
  /** Jugador ganador, contando desde 1 (0 si hay empate en cabeza). */
  winnerPlayerNumber: number;
  playerCount: number;
  /** Total de cada jugador, en orden de turno. */
  playerTotalPoints: number[];
  /** Código de 4 cifras: con el mismo código salen los mismos colores. */
  gameCode: number;
  /** Colores objetivo de cada ronda (`#RRGGBB` separados por espacios). */
  targetColors: string;
  /** Mejor captura de cada ronda (`#RRGGBB` o `-` si nadie cazó nada). */
  bestCapturedColors: string;
  /** ΔE00 de la mejor captura de cada ronda (-1 si nadie cazó nada). */
  bestRoundDeltaE: number[];
  /** La captura más fiel de toda la partida. */
  bestCaptureColor?: string;
  bestCaptureDeltaE?: number;
  isWhiteBalanced: boolean;
  isPersonalRecord: boolean;
}

export const colorHuntSchema = defineMeasurementSchema<ColorHuntMeasurementValues>(1, [
  { key: 'winnerTotalPoints', labelKey: 'fields.winnerTotalPoints', type: 'number' },
  { key: 'winnerPlayerNumber', labelKey: 'fields.winnerPlayerNumber', type: 'number' },
  { key: 'playerCount', labelKey: 'fields.playerCount', type: 'number' },
  { key: 'playerTotalPoints', labelKey: 'fields.playerTotalPoints', type: 'numberArray' },
  { key: 'bestCaptureColor', labelKey: 'fields.bestCaptureColor', type: 'color', optional: true },
  { key: 'bestCaptureDeltaE', labelKey: 'fields.bestCaptureDeltaE', type: 'number', unit: 'ΔE00', optional: true },
  { key: 'bestRoundDeltaE', labelKey: 'fields.bestRoundDeltaE', type: 'numberArray', unit: 'ΔE00' },
  { key: 'targetColors', labelKey: 'fields.targetColors', type: 'string' },
  { key: 'bestCapturedColors', labelKey: 'fields.bestCapturedColors', type: 'string' },
  { key: 'gameCode', labelKey: 'fields.gameCode', type: 'number' },
  { key: 'isWhiteBalanced', labelKey: 'fields.isWhiteBalanced', type: 'boolean' },
  { key: 'isPersonalRecord', labelKey: 'fields.isPersonalRecord', type: 'boolean' },
]);

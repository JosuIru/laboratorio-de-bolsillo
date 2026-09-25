import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface RoomAcousticsMeasurementValues {
  /** Media de 500 Hz y 1 kHz; falta si alguna de las dos bandas no dio un valor fiable. */
  midReverberationSeconds?: number;
  roomCharacter?: string;
  bandCentersHz: number[];
  /** T30 o, si no, T20 de cada banda; −1 si no hubo valor fiable. */
  bandReverberationSeconds: number[];
  /** EDT de cada banda; −1 si no hubo valor. */
  bandEarlyDecaySeconds: number[];
  bandDynamicRangeDecibels: number[];
  noiseLevelDecibels: number;
  isClipped: boolean;
}

export const roomAcousticsSchema = defineMeasurementSchema<RoomAcousticsMeasurementValues>(1, [
  {
    key: 'midReverberationSeconds',
    labelKey: 'fields.midReverberationSeconds',
    type: 'number',
    unit: 's',
    optional: true,
  },
  { key: 'roomCharacter', labelKey: 'fields.roomCharacter', type: 'string', optional: true },
  { key: 'bandCentersHz', labelKey: 'fields.bandCentersHz', type: 'numberArray', unit: 'Hz' },
  { key: 'bandReverberationSeconds', labelKey: 'fields.bandReverberationSeconds', type: 'numberArray', unit: 's' },
  { key: 'bandEarlyDecaySeconds', labelKey: 'fields.bandEarlyDecaySeconds', type: 'numberArray', unit: 's' },
  { key: 'bandDynamicRangeDecibels', labelKey: 'fields.bandDynamicRangeDecibels', type: 'numberArray', unit: 'dB' },
  { key: 'noiseLevelDecibels', labelKey: 'fields.noiseLevelDecibels', type: 'number', unit: 'dBFS' },
  { key: 'isClipped', labelKey: 'fields.isClipped', type: 'boolean' },
]);

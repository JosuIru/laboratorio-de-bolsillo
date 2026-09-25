import { defineMeasurementSchema } from '@/core/measurements/schema';

/** Un mensaje recibido, con lo necesario para valorar el enlace. */
export interface PhoneModemMeasurementValues {
  /** 'sound' o 'light'. */
  channel: string;
  messageText: string;
  isSecret: boolean;
  /** Bits en el aire por segundo. */
  rawBitRate: number;
  /** Calidad del enlace, 0-100. */
  linkQualityPercent: number;
  /** Bits que ocupó la trama en el canal. */
  channelBitCount: number;
  /** Bits corregidos por Hamming (solo sonido). */
  correctedBitCount: number;
}

export const phoneModemSchema = defineMeasurementSchema<PhoneModemMeasurementValues>(1, [
  { key: 'channel', labelKey: 'fields.channel', type: 'string' },
  { key: 'messageText', labelKey: 'fields.message', type: 'string' },
  { key: 'isSecret', labelKey: 'fields.secret', type: 'boolean' },
  { key: 'rawBitRate', labelKey: 'fields.bitRate', type: 'number', unit: 'bit/s' },
  { key: 'linkQualityPercent', labelKey: 'fields.quality', type: 'number', unit: '%' },
  { key: 'channelBitCount', labelKey: 'fields.channelBits', type: 'number' },
  { key: 'correctedBitCount', labelKey: 'fields.correctedBits', type: 'number' },
]);

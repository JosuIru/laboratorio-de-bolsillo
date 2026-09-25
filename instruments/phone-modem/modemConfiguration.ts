import {
  acousticConfigurationFor,
  acousticRawBitRate,
  type AcousticBandPreset,
  type AcousticSpeedPreset,
} from '@/processing/modem/acousticModem';
import type { ErrorCorrection } from '@/processing/modem/frameCodec';
import { opticalConfigurationFor, opticalRawBitRate, type OpticalSpeedPreset } from '@/processing/modem/opticalModem';
import type { TextEncoding } from '@/processing/modem/textCodec';

export const phoneModemInstrumentId = 'phone-modem';

export type ModemChannel = 'sound' | 'light';
export type ModemDirection = 'send' | 'receive';
export type LightEmitter = 'screen' | 'torch';

/**
 * Por el sonido sobra capacidad: Hamming (7,4) + entrelazado para aguantar golpes y ecos.
 * Por la luz cada bit cuesta décimas de segundo: sin corrección de errores (el CRC avisa).
 */
export const errorCorrectionByChannel: Record<ModemChannel, ErrorCorrection> = {
  sound: 'hamming',
  light: 'none',
};

/** Por la luz se usa el alfabeto compacto (mayúsculas, 6 bits) siempre que el texto quepa. */
export const preferredEncodingByChannel: Record<ModemChannel, TextEncoding | 'auto'> = {
  sound: 'utf8',
  light: 'auto',
};

export const acousticBandOptions: readonly AcousticBandPreset[] = ['ultrasonic', 'audible'];
export const acousticSpeedOptions: readonly AcousticSpeedPreset[] = ['slow', 'normal', 'fast'];
export const opticalSpeedOptions: readonly OpticalSpeedPreset[] = ['slow', 'normal', 'fast'];

/** Fracción de bits útiles de Hamming (7,4). */
const hammingCodeRate = 4 / 7;

/** Velocidades de un canal: bruta (bits en el aire) y útil (sin corrección de errores). */
export function channelBitRates(
  channel: ModemChannel,
  acousticSpeed: AcousticSpeedPreset,
  opticalSpeed: OpticalSpeedPreset,
): { rawBitsPerSecond: number; usefulBitsPerSecond: number } {
  if (channel === 'sound') {
    const rawBitsPerSecond = acousticRawBitRate(acousticConfigurationFor('ultrasonic', acousticSpeed));
    return { rawBitsPerSecond, usefulBitsPerSecond: rawBitsPerSecond * hammingCodeRate };
  }
  const rawBitsPerSecond = opticalRawBitRate(opticalConfigurationFor(opticalSpeed));
  return { rawBitsPerSecond, usefulBitsPerSecond: rawBitsPerSecond };
}

/** Volumen de emisión por sonido (0-1). */
export const acousticVolume = 0.8;

/** Mensajes de ejemplo para el juego de espías (claves i18n dentro de `presets`). */
export const spyPresetKeys = ['eagle', 'package', 'midnight', 'umbrella', 'abort'] as const;

/** Segundos que tarda en «autodestruirse» un mensaje secreto ya descifrado. */
export const selfDestructSeconds = 30;

/**
 * Señal de referencia del localizador: dos chirridos audibles idénticos separados un tiempo fijo.
 *
 * El primero marca el «cero» común a todos los móviles (cada uno lo oye con su propio reloj) y el
 * segundo sirve para medir cuánto se adelanta o se atrasa el reloj de audio de cada móvil respecto
 * al del emisor: si el emisor los separa exactamente 3 s y un móvil mide 3,000 15 s, su reloj va
 * 50 ppm rápido y hay que corregir sus intervalos en esa proporción.
 */

import { generateSonarChirp, type SonarChirpSpecification } from '@/processing/sonar/chirp';

/**
 * Chirrido de 60 ms entre 1,5 y 7,5 kHz: lo reproduce bien cualquier altavoz de móvil y, con un
 * producto tiempo × ancho de banda de 360, el filtro adaptado lo encuentra con mucho ruido.
 */
export const referenceChirpSpecification: SonarChirpSpecification = {
  startFrequencyHz: 1500,
  endFrequencyHz: 7500,
  durationSeconds: 0.06,
  taperFraction: 0.1,
  amplitude: 0.9,
};

/** Separación entre el comienzo de los dos chirridos, en segundos del reloj del emisor. */
export const referenceChirpSeparationSeconds = 3;

export function generateReferenceChirp(sampleRateHz: number): Float32Array {
  return generateSonarChirp(referenceChirpSpecification, sampleRateHz);
}

/**
 * Lo que reproduce el emisor: chirrido, silencio y chirrido, más un poco de silencio al final para
 * que el altavoz no corte el segundo. La separación es un número exacto de muestras.
 */
export function generateReferenceSequence(sampleRateHz: number): Float32Array {
  const chirpSamples = generateReferenceChirp(sampleRateHz);
  const separationSamples = Math.round(referenceChirpSeparationSeconds * sampleRateHz);
  const tailSamples = Math.round(0.1 * sampleRateHz);
  const sequence = new Float32Array(separationSamples + chirpSamples.length + tailSamples);
  sequence.set(chirpSamples, 0);
  sequence.set(chirpSamples, separationSamples);
  return sequence;
}

import { encodeUtf8 } from './textCodec';

/**
 * «Mensajes secretos» del juego de espías: los bits del mensaje se mezclan (XOR) con una
 * secuencia pseudoaleatoria que sale de una palabra clave. Quien no tenga la clave ve basura.
 *
 * OJO: es un juego, no criptografía. Una clave corta se adivina probando, y el generador
 * (xorshift32) no resiste un análisis. No sirve para proteger nada de verdad.
 */

/** Primer byte del contenido cifrado: con la clave buena se descifra siempre a este valor. */
export const secretKeyCheckByte = 0xa5;

/** Hash FNV-1a de 32 bits de la clave (normalizada: sin espacios en los extremos, en minúsculas). */
function hashSecretKey(secretKey: string): number {
  let hashValue = 0x811c9dc5;
  for (const keyByte of encodeUtf8(secretKey.trim().toLowerCase())) {
    hashValue ^= keyByte;
    hashValue = Math.imul(hashValue, 0x01000193) >>> 0;
  }
  return hashValue >>> 0;
}

export function normalizeSecretKey(secretKey: string): string {
  return secretKey.trim().toLowerCase();
}

/** Mezcla (o desmezcla: la operación es su propia inversa) los bits con la clave. */
export function scrambleBitsWithKey(bits: readonly number[], secretKey: string): number[] {
  let generatorState = hashSecretKey(secretKey) || 0x9e3779b9;
  const scrambledBits: number[] = [];
  for (const bit of bits) {
    generatorState ^= generatorState << 13;
    generatorState ^= generatorState >>> 17;
    generatorState ^= generatorState << 5;
    generatorState >>>= 0;
    scrambledBits.push((bit ^ (generatorState >>> 31)) & 1);
  }
  return scrambledBits;
}

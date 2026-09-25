/**
 * Utilidades de bits para el módem. Un bit es un número 0 o 1; las secuencias se guardan en
 * arrays normales porque las tramas son cortas (unos cientos de bits como mucho).
 * Orden: el bit más significativo primero, como se transmite.
 */

/** Añade los `bitCount` bits bajos de `value` a `targetBits`, del más significativo al menos. */
export function appendValueBits(targetBits: number[], value: number, bitCount: number): void {
  for (let bitPosition = bitCount - 1; bitPosition >= 0; bitPosition--) {
    targetBits.push((value >>> bitPosition) & 1);
  }
}

/** Lee `bitCount` bits desde `startIndex` como un entero sin signo. */
export function readValueFromBits(sourceBits: readonly number[], startIndex: number, bitCount: number): number {
  let value = 0;
  for (let bitOffset = 0; bitOffset < bitCount; bitOffset++) {
    value = (value << 1) | ((sourceBits[startIndex + bitOffset] ?? 0) & 1);
  }
  return value >>> 0;
}

export function bytesToBits(bytes: ArrayLike<number>): number[] {
  const bits: number[] = [];
  for (let byteIndex = 0; byteIndex < bytes.length; byteIndex++) appendValueBits(bits, bytes[byteIndex]!, 8);
  return bits;
}

/** Agrupa los bits en bytes; si sobran bits al final, se descartan. */
export function bitsToBytes(bits: readonly number[]): Uint8Array {
  const byteCount = Math.floor(bits.length / 8);
  const bytes = new Uint8Array(byteCount);
  for (let byteIndex = 0; byteIndex < byteCount; byteIndex++) {
    bytes[byteIndex] = readValueFromBits(bits, byteIndex * 8, 8);
  }
  return bytes;
}

/** Cuántos bits difieren entre dos secuencias (compara hasta la más corta). */
export function countBitDifferences(firstBits: readonly number[], secondBits: readonly number[]): number {
  const comparedLength = Math.min(firstBits.length, secondBits.length);
  let differenceCount = 0;
  for (let bitIndex = 0; bitIndex < comparedLength; bitIndex++) {
    if (firstBits[bitIndex] !== secondBits[bitIndex]) differenceCount++;
  }
  return differenceCount;
}

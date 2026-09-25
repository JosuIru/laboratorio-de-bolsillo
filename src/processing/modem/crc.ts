/**
 * Códigos de redundancia cíclica calculados bit a bit, para poder proteger tramas cuya
 * longitud no es un número entero de bytes.
 *
 * - CRC-8 (polinomio 0x07, valor inicial 0x00): CRC-8/SMBUS.
 * - CRC-16 (polinomio 0x1021, valor inicial 0xFFFF): CRC-16/CCITT-FALSE.
 */

function computeCrcOverBits(
  bits: readonly number[],
  widthBits: number,
  polynomial: number,
  initialValue: number,
): number {
  const topBitMask = 1 << (widthBits - 1);
  const valueMask = (1 << widthBits) - 1;
  let crcRegister = initialValue & valueMask;
  for (const bit of bits) {
    const feedbackBit = ((crcRegister & topBitMask) !== 0 ? 1 : 0) ^ (bit & 1);
    crcRegister = (crcRegister << 1) & valueMask;
    if (feedbackBit) crcRegister ^= polynomial;
  }
  return crcRegister;
}

export function crc8OverBits(bits: readonly number[]): number {
  return computeCrcOverBits(bits, 8, 0x07, 0x00);
}

export function crc16OverBits(bits: readonly number[]): number {
  return computeCrcOverBits(bits, 16, 0x1021, 0xffff);
}

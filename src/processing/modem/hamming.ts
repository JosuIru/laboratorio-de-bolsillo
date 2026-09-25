/**
 * Corrección de errores con el código de Hamming (7,4): cada grupo de 4 bits de datos viaja con
 * 3 bits de paridad y el receptor corrige cualquier bit erróneo en cada palabra de 7.
 *
 * Los errores de un canal real llegan en ráfagas (un golpe, un eco, un fotograma perdido); por
 * eso las palabras se entrelazan: se escriben por filas y se envían por columnas, de modo que
 * una ráfaga de hasta tantos bits como palabras haya toca como mucho un bit de cada palabra.
 */

export const hammingDataBitCount = 4;
export const hammingCodewordBitCount = 7;

/** Posiciones (1-7) de la palabra: p1 p2 d1 p3 d2 d3 d4. */
function encodeNibble(dataBits: readonly number[], targetBits: number[]): void {
  const [firstDataBit = 0, secondDataBit = 0, thirdDataBit = 0, fourthDataBit = 0] = dataBits;
  const firstParityBit = firstDataBit ^ secondDataBit ^ fourthDataBit;
  const secondParityBit = firstDataBit ^ thirdDataBit ^ fourthDataBit;
  const thirdParityBit = secondDataBit ^ thirdDataBit ^ fourthDataBit;
  targetBits.push(
    firstParityBit,
    secondParityBit,
    firstDataBit,
    thirdParityBit,
    secondDataBit,
    thirdDataBit,
    fourthDataBit,
  );
}

/** Codifica bits de datos (si no son múltiplo de 4, se rellenan con ceros). */
export function hammingEncode(dataBits: readonly number[]): number[] {
  const codedBits: number[] = [];
  for (let startIndex = 0; startIndex < dataBits.length; startIndex += hammingDataBitCount) {
    encodeNibble(dataBits.slice(startIndex, startIndex + hammingDataBitCount), codedBits);
  }
  return codedBits;
}

export interface HammingDecodeResult {
  dataBits: number[];
  /** Bits que el código ha corregido (uno como mucho por palabra). */
  correctedBitCount: number;
}

/** Decodifica palabras de 7 bits corrigiendo un error por palabra. */
export function hammingDecode(codedBits: readonly number[]): HammingDecodeResult {
  const dataBits: number[] = [];
  let correctedBitCount = 0;
  const codewordCount = Math.floor(codedBits.length / hammingCodewordBitCount);
  for (let codewordIndex = 0; codewordIndex < codewordCount; codewordIndex++) {
    const codeword = codedBits.slice(
      codewordIndex * hammingCodewordBitCount,
      (codewordIndex + 1) * hammingCodewordBitCount,
    );
    // El síndrome da la posición (1-7) del bit erróneo, o 0 si la palabra está bien.
    const syndromePosition =
      (codeword[0]! ^ codeword[2]! ^ codeword[4]! ^ codeword[6]!) |
      ((codeword[1]! ^ codeword[2]! ^ codeword[5]! ^ codeword[6]!) << 1) |
      ((codeword[3]! ^ codeword[4]! ^ codeword[5]! ^ codeword[6]!) << 2);
    if (syndromePosition !== 0) {
      codeword[syndromePosition - 1] = codeword[syndromePosition - 1]! ^ 1;
      correctedBitCount++;
    }
    dataBits.push(codeword[2]!, codeword[4]!, codeword[5]!, codeword[6]!);
  }
  return { dataBits, correctedBitCount };
}

/** Entrelaza palabras de `codewordBitCount` bits: se envía primero el bit 0 de todas, etc. */
export function interleaveCodewords(codedBits: readonly number[], codewordBitCount = hammingCodewordBitCount): number[] {
  const codewordCount = Math.ceil(codedBits.length / codewordBitCount);
  const interleavedBits: number[] = [];
  for (let bitPosition = 0; bitPosition < codewordBitCount; bitPosition++) {
    for (let codewordIndex = 0; codewordIndex < codewordCount; codewordIndex++) {
      const sourceIndex = codewordIndex * codewordBitCount + bitPosition;
      if (sourceIndex < codedBits.length) interleavedBits.push(codedBits[sourceIndex]!);
    }
  }
  return interleavedBits;
}

/** Deshace `interleaveCodewords` (para longitudes múltiplo de la palabra). */
export function deinterleaveCodewords(
  interleavedBits: readonly number[],
  codewordBitCount = hammingCodewordBitCount,
): number[] {
  const codewordCount = Math.ceil(interleavedBits.length / codewordBitCount);
  const codedBits = new Array<number>(codewordCount * codewordBitCount).fill(0);
  let readIndex = 0;
  for (let bitPosition = 0; bitPosition < codewordBitCount; bitPosition++) {
    for (let codewordIndex = 0; codewordIndex < codewordCount; codewordIndex++) {
      const targetIndex = codewordIndex * codewordBitCount + bitPosition;
      if (targetIndex < interleavedBits.length) codedBits[targetIndex] = interleavedBits[readIndex++] ?? 0;
    }
  }
  return codedBits.slice(0, interleavedBits.length);
}

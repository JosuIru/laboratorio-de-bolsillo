/**
 * Codificación del texto de los mensajes.
 *
 * - `utf8`: cualquier texto (8 bits por letra ASCII, más para acentos y emojis).
 * - `compact`: alfabeto «de telegrama» de 64 signos en mayúsculas, a 6 bits por letra. Por la
 *   luz, donde cada bit cuesta décimas de segundo, ahorra un 25 %.
 */

export type TextEncoding = 'utf8' | 'compact';

/** 64 signos: espacio, A-Z, 0-9, letras del castellano y del euskera y puntuación. */
export const compactAlphabet = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ÑÇÁÉÍÓÚÜ.,?!-:;\'"/()+=@#*&%';
export const compactBitsPerCharacter = 6;

const compactIndexByCharacter = new Map<string, number>(
  Array.from(compactAlphabet).map((character, characterIndex) => [character, characterIndex]),
);

/** Texto tal como se enviaría en el alfabeto compacto (en mayúsculas), o null si no cabe. */
export function toCompactText(text: string): string | null {
  const upperCaseText = text.toUpperCase();
  for (const character of upperCaseText) {
    if (!compactIndexByCharacter.has(character)) return null;
  }
  return upperCaseText;
}

/** Índices del alfabeto compacto (el texto debe venir de `toCompactText`). */
export function encodeCompactText(compactText: string): number[] {
  return Array.from(compactText).map((character) => compactIndexByCharacter.get(character) ?? 0);
}

export function decodeCompactText(characterIndices: readonly number[]): string {
  return characterIndices.map((characterIndex) => compactAlphabet[characterIndex & 63] ?? '?').join('');
}

export function encodeUtf8(text: string): Uint8Array {
  const encodedBytes: number[] = [];
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x80) {
      encodedBytes.push(codePoint);
    } else if (codePoint < 0x800) {
      encodedBytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      encodedBytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      encodedBytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(encodedBytes);
}

const replacementCharacter = '�';

/** Decodifica UTF-8 tolerando errores: cada secuencia inválida se convierte en «�». */
export function decodeUtf8(bytes: ArrayLike<number>): string {
  let decodedText = '';
  let byteIndex = 0;
  while (byteIndex < bytes.length) {
    const leadByte = bytes[byteIndex]!;
    let continuationCount: number;
    let codePoint: number;
    if (leadByte < 0x80) {
      continuationCount = 0;
      codePoint = leadByte;
    } else if ((leadByte & 0xe0) === 0xc0) {
      continuationCount = 1;
      codePoint = leadByte & 0x1f;
    } else if ((leadByte & 0xf0) === 0xe0) {
      continuationCount = 2;
      codePoint = leadByte & 0x0f;
    } else if ((leadByte & 0xf8) === 0xf0) {
      continuationCount = 3;
      codePoint = leadByte & 0x07;
    } else {
      decodedText += replacementCharacter;
      byteIndex++;
      continue;
    }
    let isValidSequence = byteIndex + continuationCount < bytes.length;
    for (let continuationOffset = 1; isValidSequence && continuationOffset <= continuationCount; continuationOffset++) {
      const continuationByte = bytes[byteIndex + continuationOffset]!;
      if ((continuationByte & 0xc0) !== 0x80) isValidSequence = false;
      else codePoint = (codePoint << 6) | (continuationByte & 0x3f);
    }
    if (!isValidSequence || codePoint > 0x10ffff) {
      decodedText += replacementCharacter;
      byteIndex++;
      continue;
    }
    decodedText += String.fromCodePoint(codePoint);
    byteIndex += continuationCount + 1;
  }
  return decodedText;
}

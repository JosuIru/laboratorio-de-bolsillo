import { appendValueBits, bitsToBytes, bytesToBits, readValueFromBits } from './bits';
import { crc16OverBits } from './crc';
import {
  deinterleaveCodewords,
  hammingCodewordBitCount,
  hammingDataBitCount,
  hammingDecode,
  hammingEncode,
  interleaveCodewords,
} from './hamming';
import { normalizeSecretKey, scrambleBitsWithKey, secretKeyCheckByte } from './secretScrambler';
import {
  compactBitsPerCharacter,
  decodeCompactText,
  decodeUtf8,
  encodeCompactText,
  encodeUtf8,
  type TextEncoding,
  toCompactText,
} from './textCodec';

/**
 * Capa de enlace del módem: convierte un mensaje en la secuencia de bits de una trama y la
 * reconstruye en el receptor. Es igual para el sonido y para la luz; solo cambia la capa física.
 *
 * Trama (antes de la corrección de errores):
 *
 *   cabecera (8 bits)                     contenido                        CRC-16
 *   [compacto][secreto][longitud: 6 bits] [clave?: 8 bits][texto: n×6 u n×8 bits] [16 bits]
 *
 * - `longitud`: letras (compacto) o bytes (UTF-8) del texto, de 1 a 63.
 * - `secreto`: el contenido va mezclado con una clave; su primer byte descifrado es
 *   `secretKeyCheckByte`, para saber si la clave es la buena.
 * - El CRC-16 cubre cabecera y contenido tal como viajan (mezclados), así que se comprueba
 *   sin conocer la clave.
 *
 * Con corrección de errores (Hamming 7,4), la cabecera va codificada sola (14 bits) para que
 * el receptor sepa pronto cuánto ocupa el resto; contenido y CRC se codifican y se entrelazan.
 */

export type ErrorCorrection = 'none' | 'hamming';

export const headerBitCount = 8;
export const crcBitCount = 16;
export const maximumTextUnitCount = 63;

export interface FrameHeader {
  textEncoding: TextEncoding;
  isSecret: boolean;
  /** Letras (compacto) o bytes (UTF-8) del texto. */
  textUnitCount: number;
}

export interface OutgoingMessage {
  text: string;
  /** Palabra clave para mezclar el mensaje; vacía o ausente = mensaje en claro. */
  secretKey?: string;
  /** `auto` usa el alfabeto compacto si el texto cabe en él. */
  preferredEncoding?: TextEncoding | 'auto';
}

export interface PreparedMessage {
  header: FrameHeader;
  /** Texto tal como llegará (en mayúsculas si va en el alfabeto compacto). */
  transmittedText: string;
  /** Bits de la trama ya codificados para el canal (con corrección de errores si se pidió). */
  channelBits: number[];
}

export class MessageTooLongError extends Error {
  constructor(readonly textUnitCount: number) {
    super(`El mensaje ocupa ${textUnitCount} unidades y caben ${maximumTextUnitCount}`);
    this.name = 'MessageTooLongError';
  }
}

function payloadBitCountFor(header: FrameHeader): number {
  const bitsPerUnit = header.textEncoding === 'compact' ? compactBitsPerCharacter : 8;
  return (header.isSecret ? 8 : 0) + header.textUnitCount * bitsPerUnit;
}

/** Bits de la trama antes de la corrección de errores (cabecera + contenido + CRC). */
export function frameBitCountFor(header: FrameHeader): number {
  return headerBitCount + payloadBitCountFor(header) + crcBitCount;
}

function hammingCodedLength(dataBitCount: number): number {
  return Math.ceil(dataBitCount / hammingDataBitCount) * hammingCodewordBitCount;
}

/** Bits que ocupa en el canal todo lo que sigue a la cabecera. */
function bodyChannelBitCount(header: FrameHeader, errorCorrection: ErrorCorrection): number {
  const bodyBitCount = payloadBitCountFor(header) + crcBitCount;
  return errorCorrection === 'hamming' ? hammingCodedLength(bodyBitCount) : bodyBitCount;
}

export function headerChannelBitCount(errorCorrection: ErrorCorrection): number {
  return errorCorrection === 'hamming' ? hammingCodedLength(headerBitCount) : headerBitCount;
}

/** Bits totales que ocupa la trama en el canal. */
export function channelBitCountFor(header: FrameHeader, errorCorrection: ErrorCorrection): number {
  return headerChannelBitCount(errorCorrection) + bodyChannelBitCount(header, errorCorrection);
}

function encodeHeaderBits(header: FrameHeader): number[] {
  const headerBits: number[] = [header.textEncoding === 'compact' ? 1 : 0, header.isSecret ? 1 : 0];
  appendValueBits(headerBits, header.textUnitCount, 6);
  return headerBits;
}

function decodeHeaderBits(headerBits: readonly number[]): FrameHeader {
  return {
    textEncoding: headerBits[0] ? 'compact' : 'utf8',
    isSecret: headerBits[1] === 1,
    textUnitCount: readValueFromBits(headerBits, 2, 6),
  };
}

/** Prepara la trama de un mensaje. Lanza `MessageTooLongError` si no cabe. */
export function prepareMessage(outgoingMessage: OutgoingMessage, errorCorrection: ErrorCorrection): PreparedMessage {
  const preferredEncoding = outgoingMessage.preferredEncoding ?? 'auto';
  const compactText = preferredEncoding === 'utf8' ? null : toCompactText(outgoingMessage.text);
  const textEncoding: TextEncoding = compactText !== null ? 'compact' : 'utf8';
  const transmittedText = compactText ?? outgoingMessage.text;

  const textBits: number[] = [];
  let textUnitCount: number;
  if (textEncoding === 'compact') {
    const characterIndices = encodeCompactText(transmittedText);
    textUnitCount = characterIndices.length;
    for (const characterIndex of characterIndices) appendValueBits(textBits, characterIndex, compactBitsPerCharacter);
  } else {
    const textBytes = encodeUtf8(transmittedText);
    textUnitCount = textBytes.length;
    textBits.push(...bytesToBits(textBytes));
  }
  if (textUnitCount > maximumTextUnitCount) throw new MessageTooLongError(textUnitCount);

  const secretKey = normalizeSecretKey(outgoingMessage.secretKey ?? '');
  const isSecret = secretKey.length > 0;
  const header: FrameHeader = { textEncoding, isSecret, textUnitCount };
  const payloadBits = isSecret
    ? scrambleBitsWithKey([...bytesToBits([secretKeyCheckByte]), ...textBits], secretKey)
    : textBits;

  const headerBits = encodeHeaderBits(header);
  const crcBits: number[] = [];
  appendValueBits(crcBits, crc16OverBits([...headerBits, ...payloadBits]), crcBitCount);
  const bodyBits = [...payloadBits, ...crcBits];

  const channelBits =
    errorCorrection === 'hamming'
      ? [...hammingEncode(headerBits), ...interleaveCodewords(hammingEncode(bodyBits))]
      : [...headerBits, ...bodyBits];
  return { header, transmittedText, channelBits };
}

export interface ReceivedFrame {
  header: FrameHeader;
  /** Contenido tal como viajó (mezclado si es secreto): permite probar claves después. */
  payloadBits: number[];
  isCrcValid: boolean;
  /** Bits corregidos por Hamming (0 sin corrección de errores). */
  correctedBitCount: number;
  channelBitCount: number;
}

export type FrameCollectorState =
  | { phase: 'header'; collectedBitCount: number; expectedBitCount: number }
  | { phase: 'body'; header: FrameHeader; collectedBitCount: number; expectedBitCount: number }
  | { phase: 'complete'; frame: ReceivedFrame }
  | { phase: 'invalidHeader'; header: FrameHeader };

export interface FrameCollector {
  /** Añade un bit recibido; devuelve el estado tras añadirlo. */
  pushBit(bit: number): FrameCollectorState;
  readonly state: FrameCollectorState;
}

/**
 * Recoge los bits de una trama según llegan del canal. Cuando tiene la cabecera sabe cuántos
 * bits faltan; al completarlos, deshace la corrección de errores y comprueba el CRC.
 */
export function createFrameCollector(errorCorrection: ErrorCorrection): FrameCollector {
  const collectedBits: number[] = [];
  const headerLength = headerChannelBitCount(errorCorrection);
  let header: FrameHeader | null = null;
  let headerCorrectedBitCount = 0;
  let expectedBitCount = headerLength;
  let state: FrameCollectorState = { phase: 'header', collectedBitCount: 0, expectedBitCount };

  function finishFrame(completeHeader: FrameHeader): FrameCollectorState {
    const bodyChannelBits = collectedBits.slice(headerLength);
    let bodyBits: number[];
    let correctedBitCount = headerCorrectedBitCount;
    if (errorCorrection === 'hamming') {
      const decodedBody = hammingDecode(deinterleaveCodewords(bodyChannelBits));
      bodyBits = decodedBody.dataBits;
      correctedBitCount += decodedBody.correctedBitCount;
    } else {
      bodyBits = bodyChannelBits;
    }
    const payloadBitCount = payloadBitCountFor(completeHeader);
    const payloadBits = bodyBits.slice(0, payloadBitCount);
    const receivedCrc = readValueFromBits(bodyBits, payloadBitCount, crcBitCount);
    const computedCrc = crc16OverBits([...encodeHeaderBits(completeHeader), ...payloadBits]);
    return {
      phase: 'complete',
      frame: {
        header: completeHeader,
        payloadBits,
        isCrcValid: receivedCrc === computedCrc,
        correctedBitCount,
        channelBitCount: collectedBits.length,
      },
    };
  }

  return {
    get state() {
      return state;
    },
    pushBit(bit) {
      if (state.phase === 'complete' || state.phase === 'invalidHeader') return state;
      collectedBits.push(bit & 1);
      if (!header && collectedBits.length === headerLength) {
        let headerBits = collectedBits.slice(0, headerLength);
        if (errorCorrection === 'hamming') {
          const decodedHeader = hammingDecode(headerBits);
          headerBits = decodedHeader.dataBits;
          headerCorrectedBitCount = decodedHeader.correctedBitCount;
        }
        const decodedHeader = decodeHeaderBits(headerBits);
        if (decodedHeader.textUnitCount === 0) {
          state = { phase: 'invalidHeader', header: decodedHeader };
          return state;
        }
        header = decodedHeader;
        expectedBitCount = headerLength + bodyChannelBitCount(header, errorCorrection);
      }
      if (header && collectedBits.length >= expectedBitCount) {
        state = finishFrame(header);
      } else if (header) {
        state = { phase: 'body', header, collectedBitCount: collectedBits.length, expectedBitCount };
      } else {
        state = { phase: 'header', collectedBitCount: collectedBits.length, expectedBitCount };
      }
      return state;
    },
  };
}

export type SecretKeyStatus = 'notSecret' | 'missingKey' | 'correct' | 'wrong';

export interface DecodedMessage {
  /** Texto legible, o null si es secreto y falta la clave buena. */
  text: string | null;
  /** Lo que se ve sin la clave: el contenido mezclado interpretado como texto. */
  garbledText: string;
  secretKeyStatus: SecretKeyStatus;
}

function decodeTextBits(textBits: readonly number[], header: FrameHeader): string {
  if (header.textEncoding === 'compact') {
    const characterIndices: number[] = [];
    for (let characterIndex = 0; characterIndex < header.textUnitCount; characterIndex++) {
      characterIndices.push(
        readValueFromBits(textBits, characterIndex * compactBitsPerCharacter, compactBitsPerCharacter),
      );
    }
    return decodeCompactText(characterIndices);
  }
  return decodeUtf8(bitsToBytes(textBits));
}

/** Convierte el contenido de una trama en texto, descifrándolo si se da la clave. */
export function decodeMessage(frame: Pick<ReceivedFrame, 'header' | 'payloadBits'>, secretKey = ''): DecodedMessage {
  const { header, payloadBits } = frame;
  if (!header.isSecret) {
    const text = decodeTextBits(payloadBits, header);
    return { text, garbledText: text, secretKeyStatus: 'notSecret' };
  }
  const garbledText = decodeTextBits(payloadBits.slice(8), header);
  const normalizedKey = normalizeSecretKey(secretKey);
  if (normalizedKey.length === 0) return { text: null, garbledText, secretKeyStatus: 'missingKey' };
  const unscrambledBits = scrambleBitsWithKey(payloadBits, normalizedKey);
  if (readValueFromBits(unscrambledBits, 0, 8) !== secretKeyCheckByte) {
    return { text: null, garbledText, secretKeyStatus: 'wrong' };
  }
  return { text: decodeTextBits(unscrambledBits.slice(8), header), garbledText, secretKeyStatus: 'correct' };
}

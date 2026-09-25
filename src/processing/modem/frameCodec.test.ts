import { bytesToBits } from './bits';
import { crc16OverBits, crc8OverBits } from './crc';
import {
  channelBitCountFor,
  createFrameCollector,
  decodeMessage,
  type ErrorCorrection,
  type FrameCollectorState,
  MessageTooLongError,
  prepareMessage,
} from './frameCodec';
import { deinterleaveCodewords, hammingDecode, hammingEncode, interleaveCodewords } from './hamming';
import { compactAlphabet, decodeUtf8, encodeUtf8, toCompactText } from './textCodec';
import { createSeededRandom } from './testChannel';

const asciiBits = (text: string) => bytesToBits(Array.from(text, (character) => character.charCodeAt(0)));

describe('CRC', () => {
  it('coincide con los valores de referencia de «123456789»', () => {
    expect(crc16OverBits(asciiBits('123456789'))).toBe(0x29b1); // CRC-16/CCITT-FALSE
    expect(crc8OverBits(asciiBits('123456789'))).toBe(0xf4); // CRC-8/SMBUS
  });

  it('detecta cualquier bit cambiado', () => {
    const originalBits = asciiBits('EL AGUILA');
    const originalCrc = crc16OverBits(originalBits);
    for (let bitIndex = 0; bitIndex < originalBits.length; bitIndex++) {
      const damagedBits = [...originalBits];
      damagedBits[bitIndex] = damagedBits[bitIndex]! ^ 1;
      expect(crc16OverBits(damagedBits)).not.toBe(originalCrc);
    }
  });
});

describe('Hamming (7,4) y entrelazado', () => {
  const dataBits = asciiBits('Hamming!');

  it('corrige un bit erróneo en cada palabra', () => {
    const codedBits = hammingEncode(dataBits);
    expect(codedBits).toHaveLength((dataBits.length / 4) * 7);
    for (let codewordIndex = 0; codewordIndex < codedBits.length / 7; codewordIndex++) {
      const damagedIndex = codewordIndex * 7 + (codewordIndex % 7);
      codedBits[damagedIndex] = codedBits[damagedIndex]! ^ 1;
    }
    const decoded = hammingDecode(codedBits);
    expect(decoded.dataBits).toEqual(dataBits);
    expect(decoded.correctedBitCount).toBe(dataBits.length / 4);
  });

  it('el entrelazado convierte una ráfaga de errores en errores sueltos', () => {
    const codedBits = hammingEncode(dataBits);
    const interleavedBits = interleaveCodewords(codedBits);
    expect(deinterleaveCodewords(interleavedBits)).toEqual(codedBits);
    const codewordCount = codedBits.length / 7;
    // Ráfaga tan larga como palabras hay: sin entrelazar destrozaría varias palabras.
    for (let burstIndex = 10; burstIndex < 10 + codewordCount; burstIndex++) {
      interleavedBits[burstIndex] = interleavedBits[burstIndex]! ^ 1;
    }
    expect(hammingDecode(deinterleaveCodewords(interleavedBits)).dataBits).toEqual(dataBits);
  });
});

describe('textos', () => {
  it('codifica y decodifica UTF-8 como el estándar', () => {
    expect(Array.from(encodeUtf8('aé€🦉'))).toEqual([
      0x61, 0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0xa6, 0x89,
    ]);
    const sampleText = 'Kaixo! ¿Qué tal? 🦉 ñ';
    expect(decodeUtf8(encodeUtf8(sampleText))).toBe(sampleText);
    expect(decodeUtf8([0x41, 0xff, 0xc3])).toBe('A��');
  });

  it('el alfabeto compacto tiene 64 signos distintos y pasa a mayúsculas', () => {
    expect(new Set(Array.from(compactAlphabet)).size).toBe(64);
    expect(toCompactText('Ñandú, ¿vienes?')).toBeNull(); // «¿» no está
    expect(toCompactText('Ñandú, vienes?')).toBe('ÑANDÚ, VIENES?');
  });
});

function collectFrame(channelBits: readonly number[], errorCorrection: ErrorCorrection): FrameCollectorState {
  const frameCollector = createFrameCollector(errorCorrection);
  let collectorState = frameCollector.state;
  for (const bit of channelBits) {
    collectorState = frameCollector.pushBit(bit);
    if (collectorState.phase === 'complete' || collectorState.phase === 'invalidHeader') break;
  }
  return collectorState;
}

describe('tramas', () => {
  it.each(['none', 'hamming'] as const)('ida y vuelta de mensajes (%s)', (errorCorrection) => {
    for (const text of ['A', 'HOLA MUNDO', 'Café con 🥐', 'x'.repeat(63)]) {
      const preparedMessage = prepareMessage({ text, preferredEncoding: 'utf8' }, errorCorrection);
      expect(preparedMessage.channelBits).toHaveLength(channelBitCountFor(preparedMessage.header, errorCorrection));
      const collectorState = collectFrame(preparedMessage.channelBits, errorCorrection);
      expect(collectorState.phase).toBe('complete');
      if (collectorState.phase !== 'complete') return;
      expect(collectorState.frame.isCrcValid).toBe(true);
      expect(decodeMessage(collectorState.frame).text).toBe(text);
    }
  });

  it('el alfabeto compacto ahorra bits', () => {
    const compactMessage = prepareMessage({ text: 'Reunion a las 5' }, 'none');
    const utf8Message = prepareMessage({ text: 'Reunion a las 5', preferredEncoding: 'utf8' }, 'none');
    expect(compactMessage.header.textEncoding).toBe('compact');
    expect(compactMessage.transmittedText).toBe('REUNION A LAS 5');
    expect(compactMessage.channelBits.length).toBeLessThan(utf8Message.channelBits.length);
  });

  it('rechaza mensajes demasiado largos', () => {
    expect(() => prepareMessage({ text: 'ñ'.repeat(40), preferredEncoding: 'utf8' }, 'none')).toThrow(
      MessageTooLongError,
    );
  });

  it('Hamming corrige errores sueltos al azar y el CRC avisa si hay demasiados', () => {
    const preparedMessage = prepareMessage({ text: 'Operación Medianoche', preferredEncoding: 'utf8' }, 'hamming');
    const random = createSeededRandom(21);
    const lightlyDamagedBits = preparedMessage.channelBits.map((bit, bitIndex) =>
      bitIndex % 29 === 5 ? bit ^ 1 : bit,
    );
    const lightState = collectFrame(lightlyDamagedBits, 'hamming');
    expect(lightState.phase === 'complete' && lightState.frame.isCrcValid).toBe(true);
    expect(lightState.phase === 'complete' && lightState.frame.correctedBitCount).toBeGreaterThan(3);

    const heavilyDamagedBits = preparedMessage.channelBits.map((bit, bitIndex) =>
      bitIndex >= 14 && random() < 0.3 ? bit ^ 1 : bit,
    );
    const heavyState = collectFrame(heavilyDamagedBits, 'hamming');
    expect(heavyState.phase === 'complete' && heavyState.frame.isCrcValid).toBe(false);
  });

  it('mensajes secretos: sin clave o con la mala no se leen', () => {
    const preparedMessage = prepareMessage({ text: 'LA CONTRASEÑA ES PEZ', secretKey: '  Lince ' }, 'none');
    expect(preparedMessage.header.isSecret).toBe(true);
    const collectorState = collectFrame(preparedMessage.channelBits, 'none');
    if (collectorState.phase !== 'complete') throw new Error('trama incompleta');
    const frame = collectorState.frame;
    expect(frame.isCrcValid).toBe(true);
    expect(decodeMessage(frame)).toMatchObject({ text: null, secretKeyStatus: 'missingKey' });
    expect(decodeMessage(frame, 'tigre')).toMatchObject({ text: null, secretKeyStatus: 'wrong' });
    expect(decodeMessage(frame, 'tigre').garbledText).not.toBe('LA CONTRASEÑA ES PEZ');
    expect(decodeMessage(frame, 'LINCE')).toEqual({
      text: 'LA CONTRASEÑA ES PEZ',
      garbledText: expect.any(String),
      secretKeyStatus: 'correct',
    });
  });
});

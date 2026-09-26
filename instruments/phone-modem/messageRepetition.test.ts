import type { ReceivedFrame } from '@/processing/modem/frameCodec';

import { mergeRepeatedMessage, repeatWithGaps } from './messageRepetition';

function frame(payloadBits: number[], isCrcValid: boolean): ReceivedFrame {
  return {
    header: { textEncoding: 'utf8', isSecret: false, textUnitCount: payloadBits.length / 8 },
    payloadBits,
    isCrcValid,
    correctedBitCount: 0,
    channelBitCount: payloadBits.length,
  };
}

const helloBits = [0, 1, 0, 0, 1, 0, 0, 0];
const byeBits = [0, 1, 0, 0, 0, 0, 1, 0];

describe('repeatWithGaps', () => {
  it('pone las copias separadas por silencio', () => {
    const repeated = repeatWithGaps(Float32Array.from([1, 2]), 2, 3);
    expect(Array.from(repeated)).toEqual([1, 2, 0, 0, 0, 1, 2]);
  });
});

describe('mergeRepeatedMessage', () => {
  const window = 5000;
  const good = (bits: number[], at: number) => ({ frame: frame(bits, true), receivedAtMilliseconds: at });
  const damaged = (at: number) => ({ frame: frame([1, 1, 1, 1, 1, 1, 1, 1], false), receivedAtMilliseconds: at });

  it('descarta la segunda copia buena idéntica', () => {
    const merged = mergeRepeatedMessage([good(helloBits, 1000)], good(helloBits, 3000), window);
    expect(merged).toHaveLength(1);
  });

  it('una copia buena sustituye a la dañada', () => {
    const merged = mergeRepeatedMessage([damaged(1000)], good(helloBits, 3000), window);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.frame.isCrcValid).toBe(true);
  });

  it('una copia dañada tras una buena se ignora', () => {
    const merged = mergeRepeatedMessage([good(helloBits, 1000)], damaged(3000), window);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.frame.isCrcValid).toBe(true);
  });

  it('dos dañadas seguidas cuentan como un solo mensaje dañado', () => {
    expect(mergeRepeatedMessage([damaged(1000)], damaged(3000), window)).toHaveLength(1);
  });

  it('otro mensaje bueno distinto se añade', () => {
    expect(mergeRepeatedMessage([good(helloBits, 1000)], good(byeBits, 3000), window)).toHaveLength(2);
  });

  it('fuera de la ventana se añade aunque sea igual', () => {
    expect(mergeRepeatedMessage([good(helloBits, 1000)], good(helloBits, 9000), window)).toHaveLength(2);
  });
});

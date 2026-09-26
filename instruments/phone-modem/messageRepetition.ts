import type { ReceivedFrame } from '@/processing/modem/frameCodec';

/**
 * Por sonido cada mensaje se emite dos veces seguidas. Con eco fuerte, la sincronía a veces se
 * engancha a un eco y la trama llega dañada (un 10-20 % de las veces en simulación, sea cual sea
 * la longitud); con dos copias independientes, que fallen las dos baja a un 1-4 %.
 */
export const acousticRepeatCount = 2;
/** Silencio entre copias, para que el eco de la primera no pise el preámbulo de la segunda. */
export const acousticRepeatGapSeconds = 0.3;

/** Une varias copias de la señal de una trama con silencios entre ellas. */
export function repeatWithGaps(frameSamples: Float32Array, repeatCount: number, gapSampleCount: number): Float32Array<ArrayBuffer> {
  const repeatedSamples = new Float32Array(repeatCount * frameSamples.length + (repeatCount - 1) * gapSampleCount);
  for (let copyIndex = 0; copyIndex < repeatCount; copyIndex++) {
    repeatedSamples.set(frameSamples, copyIndex * (frameSamples.length + gapSampleCount));
  }
  return repeatedSamples;
}

export interface RepeatableMessage {
  frame: ReceivedFrame;
  receivedAtMilliseconds: number;
}

function haveSameContent(leftFrame: ReceivedFrame, rightFrame: ReceivedFrame): boolean {
  return (
    leftFrame.header.textEncoding === rightFrame.header.textEncoding &&
    leftFrame.header.isSecret === rightFrame.header.isSecret &&
    leftFrame.header.textUnitCount === rightFrame.header.textUnitCount &&
    leftFrame.payloadBits.length === rightFrame.payloadBits.length &&
    leftFrame.payloadBits.every((bit, bitIndex) => bit === rightFrame.payloadBits[bitIndex])
  );
}

/**
 * Añade un mensaje a la lista (la más reciente primero) juntando las copias de una misma emisión:
 * si llega a menos de `repeatWindowMilliseconds` del anterior,
 * - una copia buena idéntica a otra buena se descarta (ya se tiene);
 * - una copia buena sustituye a una dañada (la dañada era la otra copia);
 * - una copia dañada tras una buena se descarta.
 * Fuera de esa ventana, o si el anterior es otro mensaje bueno, se añade sin más.
 */
export function mergeRepeatedMessage<TMessage extends RepeatableMessage>(
  previousMessages: readonly TMessage[],
  newMessage: TMessage,
  repeatWindowMilliseconds: number,
): TMessage[] {
  const latestMessage = previousMessages[0];
  const isWithinWindow =
    latestMessage !== undefined &&
    newMessage.receivedAtMilliseconds - latestMessage.receivedAtMilliseconds <= repeatWindowMilliseconds;
  if (!latestMessage || !isWithinWindow) return [newMessage, ...previousMessages];
  const isNewValid = newMessage.frame.isCrcValid;
  const isLatestValid = latestMessage.frame.isCrcValid;
  if (isNewValid && isLatestValid) {
    return haveSameContent(newMessage.frame, latestMessage.frame) ? [...previousMessages] : [newMessage, ...previousMessages];
  }
  if (isNewValid && !isLatestValid) return [newMessage, ...previousMessages.slice(1)];
  if (!isNewValid && isLatestValid) return [...previousMessages];
  return [newMessage, ...previousMessages.slice(1)];
}

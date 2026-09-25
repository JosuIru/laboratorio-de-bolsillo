import {
  acousticConfigurationFor,
  type AcousticModemConfiguration,
  type AcousticReceiverEvent,
  acousticTransmissionDurationSeconds,
  bitsToToneIndices,
  createAcousticReceiver,
  isAcousticConfigurationSupported,
  modulateAcousticFrame,
} from './acousticModem';
import { decodeMessage, type ErrorCorrection, prepareMessage } from './frameCodec';
import { createSeededRandom, gaussianSample, resampleLinear } from './testChannel';

interface ChannelImpairments {
  receiverSampleRateHz?: number;
  clockMismatchPartsPerMillion?: number;
  leadingSilenceSeconds?: number;
  gain?: number;
  /** Desviación típica del ruido blanco. */
  noiseLevel?: number;
  echoDelaySeconds?: number;
  echoGain?: number;
  /** Tono interferente constante (p. ej. otra máquina). */
  interferenceFrequencyHz?: number;
  interferenceLevel?: number;
  seed?: number;
}

/** Pasa la señal por un canal simulado: retardo, eco, reloj distinto, ganancia y ruido. */
function simulateAcousticChannel(
  transmittedSamples: Float32Array,
  transmitterSampleRateHz: number,
  {
    receiverSampleRateHz = transmitterSampleRateHz,
    clockMismatchPartsPerMillion = 0,
    leadingSilenceSeconds = 0.3,
    gain = 0.05,
    noiseLevel = 0.002,
    echoDelaySeconds = 0,
    echoGain = 0,
    interferenceFrequencyHz = 0,
    interferenceLevel = 0,
    seed = 1,
  }: ChannelImpairments = {},
): Float32Array {
  const echoDelaySamples = Math.round(echoDelaySeconds * transmitterSampleRateHz);
  const withEcho = new Float32Array(transmittedSamples.length + echoDelaySamples);
  for (let sampleIndex = 0; sampleIndex < transmittedSamples.length; sampleIndex++) {
    withEcho[sampleIndex]! += transmittedSamples[sampleIndex]!;
    withEcho[sampleIndex + echoDelaySamples]! += echoGain * transmittedSamples[sampleIndex]!;
  }
  const rateRatio = (receiverSampleRateHz / transmitterSampleRateHz) * (1 + clockMismatchPartsPerMillion * 1e-6);
  const resampled = resampleLinear(withEcho, rateRatio);
  const leadingSampleCount = Math.round(leadingSilenceSeconds * receiverSampleRateHz);
  const trailingSampleCount = Math.round(0.3 * receiverSampleRateHz);
  const received = new Float32Array(leadingSampleCount + resampled.length + trailingSampleCount);
  const random = createSeededRandom(seed);
  for (let sampleIndex = 0; sampleIndex < received.length; sampleIndex++) {
    const signalIndex = sampleIndex - leadingSampleCount;
    const signalValue = signalIndex >= 0 && signalIndex < resampled.length ? resampled[signalIndex]! : 0;
    const interferenceValue =
      interferenceLevel * Math.sin((2 * Math.PI * interferenceFrequencyHz * sampleIndex) / receiverSampleRateHz);
    received[sampleIndex] = gain * signalValue + interferenceValue + noiseLevel * gaussianSample(random);
  }
  return received;
}

/** Entrega la señal al receptor en bloques de 2048 muestras, como el micrófono. */
function receiveInChunks(
  receivedSamples: Float32Array,
  configuration: AcousticModemConfiguration,
  sampleRateHz: number,
  errorCorrection: ErrorCorrection,
): AcousticReceiverEvent[] {
  const receiver = createAcousticReceiver({ sampleRateHz, configuration, errorCorrection });
  const events: AcousticReceiverEvent[] = [];
  for (let chunkStart = 0; chunkStart < receivedSamples.length; chunkStart += 2048) {
    events.push(...receiver.pushSamples(receivedSamples.subarray(chunkStart, chunkStart + 2048)));
  }
  return events;
}

function receivedTexts(events: AcousticReceiverEvent[], secretKey = ''): (string | null)[] {
  return events
    .filter((event) => event.type === 'frameReceived' && event.frame.isCrcValid)
    .map((event) => (event.type === 'frameReceived' ? decodeMessage(event.frame, secretKey).text : null));
}

const transmitterSampleRateHz = 48000;
const spyMessage = 'El águila ha aterrizado 🦅';

describe('modulateAcousticFrame', () => {
  const configuration = acousticConfigurationFor('ultrasonic', 'normal');
  const channelBits = prepareMessage({ text: 'HOLA' }, 'hamming').channelBits;
  const samples = modulateAcousticFrame(channelBits, configuration, transmitterSampleRateHz);

  it('dura lo previsto y empieza y acaba en silencio', () => {
    const expectedDuration = acousticTransmissionDurationSeconds(channelBits.length, configuration);
    expect(samples.length / transmitterSampleRateHz).toBeCloseTo(expectedDuration, 2);
    expect(Math.abs(samples[0]!)).toBe(0);
    expect(Math.abs(samples[samples.length - 1]!)).toBe(0);
  });

  it('no salta de golpe entre muestras (fase continua, sin clics)', () => {
    let largestStep = 0;
    for (let sampleIndex = 1; sampleIndex < samples.length; sampleIndex++) {
      largestStep = Math.max(largestStep, Math.abs(samples[sampleIndex]! - samples[sampleIndex - 1]!));
    }
    // Un seno de 19,5 kHz a 48 kHz cambia como mucho 2·sen(π·19,5/48)·0,9 ≈ 1,72 por muestra.
    expect(largestStep).toBeLessThan(1.75);
  });

  it('usa código Gray: tonos vecinos difieren en un bit', () => {
    expect(bitsToToneIndices([0, 0, 0, 1, 1, 1, 1, 0], configuration)).toEqual([0, 1, 2, 3]);
  });

  it('rechaza bandas por encima de Nyquist', () => {
    expect(isAcousticConfigurationSupported(configuration, 48000)).toBe(true);
    expect(isAcousticConfigurationSupported(configuration, 16000)).toBe(false);
  });
});

describe('módem acústico de extremo a extremo', () => {
  it.each([
    ['ultrasonic', 'slow'],
    ['ultrasonic', 'normal'],
    ['ultrasonic', 'fast'],
    ['audible', 'normal'],
  ] as const)('recibe un mensaje UTF-8 por la banda %s a velocidad %s', (bandPreset, speedPreset) => {
    const configuration = acousticConfigurationFor(bandPreset, speedPreset);
    const preparedMessage = prepareMessage({ text: spyMessage }, 'hamming');
    const transmittedSamples = modulateAcousticFrame(preparedMessage.channelBits, configuration, transmitterSampleRateHz);
    const receivedSamples = simulateAcousticChannel(transmittedSamples, transmitterSampleRateHz, { seed: 7 });
    const events = receiveInChunks(receivedSamples, configuration, transmitterSampleRateHz, 'hamming');
    expect(events[0]?.type).toBe('preambleDetected');
    expect(receivedTexts(events)).toEqual([spyMessage]);
    const frameEvent = events.find((event) => event.type === 'frameReceived');
    expect(frameEvent?.type === 'frameReceived' && frameEvent.linkQuality.qualityScore).toBeGreaterThan(0.8);
  });

  it('aguanta otro reloj (44,1 kHz frente a 48 kHz y 300 ppm), eco y retardo arbitrario', () => {
    const configuration = acousticConfigurationFor('ultrasonic', 'fast');
    const longMessage = 'Reunión en el puente viejo a medianoche. Trae paraguas rojo.';
    const preparedMessage = prepareMessage({ text: longMessage, preferredEncoding: 'utf8' }, 'hamming');
    const transmittedSamples = modulateAcousticFrame(preparedMessage.channelBits, configuration, transmitterSampleRateHz);
    const receivedSamples = simulateAcousticChannel(transmittedSamples, transmitterSampleRateHz, {
      receiverSampleRateHz: 44100,
      clockMismatchPartsPerMillion: 300,
      leadingSilenceSeconds: 0.4137,
      echoDelaySeconds: 0.0012,
      echoGain: 0.5,
      seed: 3,
    });
    const events = receiveInChunks(receivedSamples, configuration, 44100, 'hamming');
    expect(receivedTexts(events)).toEqual([longMessage]);
  });

  it('sigue la deriva de reloj con el lazo adelanto-retraso (2000 ppm en un mensaje largo)', () => {
    const configuration = acousticConfigurationFor('ultrasonic', 'fast');
    const longMessage = 'x'.repeat(60);
    const preparedMessage = prepareMessage({ text: longMessage, preferredEncoding: 'utf8' }, 'hamming');
    const transmittedSamples = modulateAcousticFrame(preparedMessage.channelBits, configuration, transmitterSampleRateHz);
    const receivedSamples = simulateAcousticChannel(transmittedSamples, transmitterSampleRateHz, {
      clockMismatchPartsPerMillion: 2000,
      seed: 4,
    });
    const events = receiveInChunks(receivedSamples, configuration, transmitterSampleRateHz, 'hamming');
    expect(receivedTexts(events)).toEqual([longMessage]);
    const frameEvent = events.find((event) => event.type === 'frameReceived');
    expect(frameEvent?.type === 'frameReceived' && frameEvent.linkQuality.timingCorrectionHops).toBeGreaterThanOrEqual(3);
  });

  it('decodifica con ruido fuerte gracias a Hamming y detecta el CRC malo cuando no puede', () => {
    const configuration = acousticConfigurationFor('ultrasonic', 'fast');
    const preparedMessage = prepareMessage({ text: spyMessage }, 'hamming');
    const transmittedSamples = modulateAcousticFrame(preparedMessage.channelBits, configuration, transmitterSampleRateHz);
    // Ruido moderado: relación señal/ruido ≈ 0 dB en banda ancha.
    const noisySamples = simulateAcousticChannel(transmittedSamples, transmitterSampleRateHz, {
      gain: 0.02,
      noiseLevel: 0.012,
      seed: 11,
    });
    const noisyEvents = receiveInChunks(noisySamples, configuration, transmitterSampleRateHz, 'hamming');
    expect(receivedTexts(noisyEvents)).toEqual([spyMessage]);

    // Ruido enorme: o no se encuentra el preámbulo o, si se encuentra, la trama no pasa el CRC.
    const hopelessSamples = simulateAcousticChannel(transmittedSamples, transmitterSampleRateHz, {
      gain: 0.01,
      noiseLevel: 0.2,
      seed: 12,
    });
    const hopelessEvents = receiveInChunks(hopelessSamples, configuration, transmitterSampleRateHz, 'hamming');
    expect(receivedTexts(hopelessEvents)).toEqual([]);
  });

  it('no se deja engañar por un tono constante que coincide con uno de los del módem', () => {
    const configuration = acousticConfigurationFor('ultrasonic', 'normal');
    const silenceWithTone = simulateAcousticChannel(new Float32Array(48000 * 2), transmitterSampleRateHz, {
      interferenceFrequencyHz: configuration.toneFrequenciesHz[0],
      interferenceLevel: 0.05,
    });
    const events = receiveInChunks(silenceWithTone, configuration, transmitterSampleRateHz, 'hamming');
    expect(events.filter((event) => event.type === 'preambleDetected')).toEqual([]);
  });

  it('recibe mensajes secretos y dos tramas seguidas', () => {
    const configuration = acousticConfigurationFor('ultrasonic', 'normal');
    const firstMessage = prepareMessage({ text: 'EL NIDO ESTA VACIO', secretKey: 'Gorrión' }, 'hamming');
    const secondMessage = prepareMessage({ text: 'Recibido', preferredEncoding: 'utf8' }, 'hamming');
    const firstSamples = modulateAcousticFrame(firstMessage.channelBits, configuration, transmitterSampleRateHz);
    const secondSamples = modulateAcousticFrame(secondMessage.channelBits, configuration, transmitterSampleRateHz);
    const bothSamples = new Float32Array(firstSamples.length + secondSamples.length);
    bothSamples.set(firstSamples, 0);
    bothSamples.set(secondSamples, firstSamples.length);
    const receivedSamples = simulateAcousticChannel(bothSamples, transmitterSampleRateHz, { seed: 5 });
    const events = receiveInChunks(receivedSamples, configuration, transmitterSampleRateHz, 'hamming');
    expect(receivedTexts(events, 'gorrión')).toEqual(['EL NIDO ESTA VACIO', 'Recibido']);
    expect(receivedTexts(events)).toEqual([null, 'Recibido']);
  });

  it('también funciona con 2 tonos y sin corrección de errores', () => {
    const configuration: AcousticModemConfiguration = { toneFrequenciesHz: [18000, 19000], symbolDurationSeconds: 0.02 };
    const preparedMessage = prepareMessage({ text: 'SOS' }, 'none');
    const transmittedSamples = modulateAcousticFrame(preparedMessage.channelBits, configuration, transmitterSampleRateHz);
    const receivedSamples = simulateAcousticChannel(transmittedSamples, transmitterSampleRateHz, { seed: 9 });
    const events = receiveInChunks(receivedSamples, configuration, transmitterSampleRateHz, 'none');
    expect(receivedTexts(events)).toEqual(['SOS']);
  });
});

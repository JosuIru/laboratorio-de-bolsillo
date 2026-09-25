import { decodeMessage, type ErrorCorrection, prepareMessage } from './frameCodec';
import { createBlinkingTileSelector, createFrameTimestampConverter, measureTileLuminances } from './lightSampling';
import {
  buildOpticalChipSequence,
  createOpticalReceiver,
  opticalConfigurationFor,
  type OpticalModemConfiguration,
  type OpticalReceiverEvent,
  opticalLightLevelAt,
  opticalTransmissionDurationSeconds,
} from './opticalModem';
import { createSeededRandom, gaussianSample } from './testChannel';

interface OpticalChannelImpairments {
  cameraFramesPerSecond?: number;
  /** Variación aleatoria (±) del instante de cada fotograma, en s. */
  frameTimingJitterSeconds?: number;
  /** Tiempo que integra cada fotograma (exposición). */
  exposureSeconds?: number;
  /** Retraso de la linterna al encender y al apagar. */
  switchOnDelaySeconds?: number;
  switchOffDelaySeconds?: number;
  /** El emisor cambia la luz solo en múltiplos de esto (refresco de pantalla), con retraso aleatorio. */
  senderTickSeconds?: number;
  /** Reloj del emisor más rápido (>1) o más lento que lo nominal. */
  senderClockRatio?: number;
  leadingIdleSeconds?: number;
  backgroundLuminance?: number;
  lightLuminance?: number;
  noiseLevel?: number;
  /** Deriva lenta de la exposición automática (fracción de ganancia por segundo). */
  autoExposureDriftPerSecond?: number;
  seed?: number;
}

/** Simula la cámara que mira una luz que parpadea según los chips. Devuelve (t, brillo). */
function simulateOpticalChannel(
  chips: readonly number[],
  configuration: OpticalModemConfiguration,
  {
    cameraFramesPerSecond = 30,
    frameTimingJitterSeconds = 0.003,
    exposureSeconds = 0.016,
    switchOnDelaySeconds = 0.03,
    switchOffDelaySeconds = 0.03,
    senderTickSeconds = 1 / 60,
    senderClockRatio = 1,
    leadingIdleSeconds = 1.37,
    backgroundLuminance = 40,
    lightLuminance = 180,
    noiseLevel = 3,
    autoExposureDriftPerSecond = 0,
    seed = 1,
  }: OpticalChannelImpairments = {},
): { timestampSeconds: number; luminance: number }[] {
  const random = createSeededRandom(seed);
  const transmissionSeconds = chips.length * configuration.chipDurationSeconds;
  const totalSeconds = leadingIdleSeconds + transmissionSeconds / senderClockRatio + 2;
  // Instantes de cada cambio de luz (con el reloj del emisor, el refresco y los retrasos).
  const switchTimes: { timeSeconds: number; level: number }[] = [];
  let previousLevel = 0;
  for (let chipIndex = 0; chipIndex <= chips.length; chipIndex++) {
    const chipLevel = chips[chipIndex] ?? 0;
    if (chipLevel === previousLevel) continue;
    const nominalSeconds = leadingIdleSeconds + (chipIndex * configuration.chipDurationSeconds) / senderClockRatio;
    const tickAlignedSeconds = Math.ceil(nominalSeconds / senderTickSeconds) * senderTickSeconds;
    const switchDelaySeconds = chipLevel ? switchOnDelaySeconds : switchOffDelaySeconds;
    switchTimes.push({ timeSeconds: tickAlignedSeconds + switchDelaySeconds + random() * 0.01, level: chipLevel });
    previousLevel = chipLevel;
  }
  const lightAt = (timeSeconds: number) => {
    let level = 0;
    for (const switchTime of switchTimes) {
      if (switchTime.timeSeconds > timeSeconds) break;
      level = switchTime.level;
    }
    return level;
  };

  const samples: { timestampSeconds: number; luminance: number }[] = [];
  for (let frameIndex = 0; frameIndex * (1 / cameraFramesPerSecond) < totalSeconds; frameIndex++) {
    const frameSeconds = frameIndex / cameraFramesPerSecond + (random() * 2 - 1) * frameTimingJitterSeconds;
    // La exposición promedia la luz durante `exposureSeconds` antes del instante del fotograma.
    let integratedLight = 0;
    const integrationSteps = 16;
    for (let stepIndex = 0; stepIndex < integrationSteps; stepIndex++) {
      integratedLight += lightAt(frameSeconds - (exposureSeconds * (stepIndex + 0.5)) / integrationSteps);
    }
    integratedLight /= integrationSteps;
    const exposureGain = Math.max(0.3, 1 - autoExposureDriftPerSecond * frameSeconds);
    samples.push({
      timestampSeconds: frameSeconds,
      luminance: Math.min(
        255,
        Math.max(0, exposureGain * (backgroundLuminance + lightLuminance * integratedLight) + noiseLevel * gaussianSample(random)),
      ),
    });
  }
  return samples;
}

function receiveOptical(
  samples: { timestampSeconds: number; luminance: number }[],
  configuration: OpticalModemConfiguration,
  errorCorrection: ErrorCorrection,
): OpticalReceiverEvent[] {
  const receiver = createOpticalReceiver({ configuration, errorCorrection });
  return samples.flatMap((sample) => receiver.pushSample(sample.timestampSeconds, sample.luminance));
}

function receivedTexts(events: OpticalReceiverEvent[], secretKey = ''): (string | null)[] {
  return events
    .filter((event) => event.type === 'frameReceived' && event.frame.isCrcValid)
    .map((event) => (event.type === 'frameReceived' ? decodeMessage(event.frame, secretKey).text : null));
}

describe('secuencia de chips', () => {
  it('lleva preámbulo, delimitador, Manchester y cierre', () => {
    const chips = buildOpticalChipSequence([1, 0]);
    expect(chips.slice(16, 22)).toEqual([1, 1, 1, 0, 0, 0]);
    expect(chips.slice(22)).toEqual([1, 0, 0, 1, 1]);
    const configuration = opticalConfigurationFor('normal');
    expect(opticalTransmissionDurationSeconds(2, configuration)).toBeCloseTo(chips.length * 0.1, 6);
  });

  it('da la luz de cada instante y la apaga fuera de la trama', () => {
    const configuration = opticalConfigurationFor('normal');
    const chips = [1, 0, 1];
    expect(opticalLightLevelAt(chips, -0.01, configuration)).toBe(0);
    expect(opticalLightLevelAt(chips, 0.05, configuration)).toBe(1);
    expect(opticalLightLevelAt(chips, 0.15, configuration)).toBe(0);
    expect(opticalLightLevelAt(chips, 0.35, configuration)).toBe(0);
  });
});

describe('módem óptico de extremo a extremo', () => {
  const spyText = 'EL PAQUETE ESTA EN LA TAQUILLA 7';

  it.each(['slow', 'normal', 'fast'] as const)('recibe un mensaje compacto a velocidad %s', (speedPreset) => {
    const configuration = opticalConfigurationFor(speedPreset);
    const preparedMessage = prepareMessage({ text: spyText }, 'none');
    const samples = simulateOpticalChannel(buildOpticalChipSequence(preparedMessage.channelBits), configuration, {
      seed: 2,
    });
    const events = receiveOptical(samples, configuration, 'none');
    expect(events[0]?.type).toBe('preambleDetected');
    expect(receivedTexts(events)).toEqual([spyText]);
  });

  it('corrige la asimetría de una linterna lenta (60 ms al encender, 10 ms al apagar)', () => {
    const configuration = opticalConfigurationFor('normal');
    const preparedMessage = prepareMessage({ text: 'SOS' }, 'none');
    const samples = simulateOpticalChannel(buildOpticalChipSequence(preparedMessage.channelBits), configuration, {
      switchOnDelaySeconds: 0.06,
      switchOffDelaySeconds: 0.01,
      seed: 3,
    });
    const events = receiveOptical(samples, configuration, 'none');
    expect(receivedTexts(events)).toEqual(['SOS']);
    const frameEvent = events.find((event) => event.type === 'frameReceived');
    expect(frameEvent?.type === 'frameReceived' && frameEvent.linkQuality.switchingAsymmetrySeconds).toBeLessThan(-0.03);
  });

  it('aguanta un reloj del emisor un 4 % rápido, poco contraste, ruido y exposición automática', () => {
    const configuration = opticalConfigurationFor('normal');
    const preparedMessage = prepareMessage({ text: 'Nos vemos en la plaza', secretKey: 'búho' }, 'hamming');
    const samples = simulateOpticalChannel(buildOpticalChipSequence(preparedMessage.channelBits), configuration, {
      senderClockRatio: 1.04,
      backgroundLuminance: 90,
      lightLuminance: 30,
      noiseLevel: 2,
      autoExposureDriftPerSecond: 0.01,
      frameTimingJitterSeconds: 0.006,
      seed: 4,
    });
    const events = receiveOptical(samples, configuration, 'hamming');
    expect(receivedTexts(events, 'Búho')).toEqual(['NOS VEMOS EN LA PLAZA']);
    const frameEvent = events.find((event) => event.type === 'frameReceived');
    expect(frameEvent?.type === 'frameReceived' && frameEvent.linkQuality.qualityScore).toBeGreaterThan(0.3);
  });

  it('no se inventa mensajes con luz fija, a oscuras o con un parpadeo cualquiera', () => {
    const configuration = opticalConfigurationFor('normal');
    const random = createSeededRandom(8);
    const randomChips = Array.from({ length: 300 }, () => (random() > 0.5 ? 1 : 0));
    for (const chips of [[], new Array<number>(100).fill(1), randomChips]) {
      const events = receiveOptical(simulateOpticalChannel(chips, configuration), configuration, 'none');
      expect(receivedTexts(events)).toEqual([]);
    }
  });

  it('da la trama por perdida si la luz se corta a medias', () => {
    const configuration = opticalConfigurationFor('normal');
    const chips = buildOpticalChipSequence(prepareMessage({ text: 'CORTADO A MEDIAS' }, 'none').channelBits);
    const truncatedChips = chips.slice(0, 60);
    const events = receiveOptical(simulateOpticalChannel(truncatedChips, configuration), configuration, 'none');
    expect(events.map((event) => event.type)).toEqual(['preambleDetected', 'frameLost']);
  });
});

describe('lectura del brillo', () => {
  it('mide el brillo de cada casilla en RGBA y BGRA', () => {
    const frameWidth = 8;
    const frameHeight = 8;
    const rgbaPixels = new Uint8Array(frameWidth * frameHeight * 4);
    // Mitad izquierda roja pura, derecha blanca.
    for (let pixelRow = 0; pixelRow < frameHeight; pixelRow++) {
      for (let pixelColumn = 0; pixelColumn < frameWidth; pixelColumn++) {
        const pixelOffset = (pixelRow * frameWidth + pixelColumn) * 4;
        const isWhite = pixelColumn >= 4;
        rgbaPixels.set([255, isWhite ? 255 : 0, isWhite ? 255 : 0, 255], pixelOffset);
      }
    }
    const rgbaTiles = measureTileLuminances(rgbaPixels, frameWidth, frameHeight, frameWidth * 4, 'rgba', 2, 1, 1);
    expect(rgbaTiles[0]).toBeCloseTo((54 * 255) / 256, 5);
    expect(rgbaTiles[1]).toBeCloseTo(255, 5);
    // El mismo búfer leído como BGRA ve la mitad izquierda azul.
    const bgraTiles = measureTileLuminances(rgbaPixels, frameWidth, frameHeight, frameWidth * 4, 'bgra', 2, 1, 1);
    expect(bgraTiles[0]).toBeCloseTo((19 * 255) / 256, 5);
  });

  it('elige la casilla que parpadea y no cambia mientras está bloqueada', () => {
    const tileSelector = createBlinkingTileSelector(4, 20);
    for (let frameIndex = 0; frameIndex < 20; frameIndex++) {
      tileSelector.push([50, 60, frameIndex % 4 < 2 ? 200 : 30, 80], false);
    }
    expect(tileSelector.selectedTileIndex).toBe(2);
    for (let frameIndex = 0; frameIndex < 20; frameIndex++) {
      tileSelector.push([frameIndex % 2 ? 250 : 0, 60, 40, 80], true);
    }
    expect(tileSelector.selectedTileIndex).toBe(2);
  });

  it('deduce la unidad de las marcas de tiempo', () => {
    const nanosecondConverter = createFrameTimestampConverter();
    nanosecondConverter(5e12);
    expect(nanosecondConverter(5e12 + 33_333_333)).toBeCloseTo(0.0333, 4);
    const secondConverter = createFrameTimestampConverter();
    secondConverter(1000.5);
    expect(secondConverter(1000.5 + 1 / 30)).toBeCloseTo(1 / 30, 6);
  });
});

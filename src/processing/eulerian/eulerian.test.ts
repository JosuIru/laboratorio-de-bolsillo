import { createBiquadState, processBiquadSample } from '@/processing/dsp/biquad';

import { reconstructAmplifiedRgba, renderVariationOverlayRgba } from './amplification';
import {
  convertFrequencyToDisplayUnit,
  magnificationBandPresets,
  resolveEffectiveBand,
} from './bands';
import {
  createRegionHistory,
  estimateDominantFrequency,
  extractCentralRegion,
  pushRegionFrame,
} from './dominantFrequency';
import { createFrameClock, detectTimestampSecondsPerUnit } from './frameTiming';
import {
  chooseBaseGridSize,
  convertToLuminance,
  convertToRgbBytes,
  downsampleFrameByBlockAverage,
  type GridImage,
  reduceGaussianLevel,
  reduceGaussianLevels,
} from './gaussianPyramid';
import { createMagnificationEngine, type GridFrame } from './magnificationEngine';
import { createPixelBandpassFilter, filterPixelFrame, resetPixelBandpassFilter } from './pixelBandpass';

/** Generador pseudoaleatorio reproducible (LCG) con salida gaussiana aproximada. */
function createNoiseGenerator(seed: number) {
  let generatorState = seed >>> 0;
  const nextUniform = () => {
    generatorState = (Math.imul(generatorState, 1664525) + 1013904223) >>> 0;
    return generatorState / 4294967296;
  };
  return () => nextUniform() + nextUniform() + nextUniform() + nextUniform() - 2;
}

function createFlatImage(width: number, height: number, channelCount: number, value: number): GridImage {
  return { pixels: new Float32Array(width * height * channelCount).fill(value), width, height, channelCount };
}

describe('pirámide gaussiana', () => {
  it('promedia bloques del fotograma respetando BGRA y el ancho de fila', () => {
    const frameWidth = 8;
    const frameHeight = 4;
    const bytesPerPixel = 4;
    const bytesPerRow = frameWidth * bytesPerPixel + 16; // relleno al final de cada fila
    const framePixels = new Uint8Array(bytesPerRow * frameHeight);
    for (let row = 0; row < frameHeight; row++) {
      for (let column = 0; column < frameWidth; column++) {
        const pixelStart = row * bytesPerRow + column * bytesPerPixel;
        // BGRA: azul = 10, verde = columna·10, rojo = 200.
        framePixels[pixelStart] = 10;
        framePixels[pixelStart + 1] = column * 10;
        framePixels[pixelStart + 2] = 200;
        framePixels[pixelStart + 3] = 255;
      }
    }
    const grid = downsampleFrameByBlockAverage(framePixels, frameWidth, frameHeight, bytesPerRow, 4, true, 2, 1, 1);
    expect(grid.width).toBe(2);
    expect(grid.height).toBe(1);
    // Bloque izquierdo: columnas 0-3 → verde medio 15; derecho: 4-7 → 55.
    expect(Array.from(grid.pixels)).toEqual([200, 15, 10, 200, 55, 10]);

    const strided = downsampleFrameByBlockAverage(framePixels, frameWidth, frameHeight, bytesPerRow, 4, true, 2, 1, 2);
    // Con paso 2 se leen las columnas 0 y 2 (izquierda) y 4 y 6 (derecha).
    expect(strided.pixels[1]).toBeCloseTo(10);
    expect(strided.pixels[4]).toBeCloseTo(50);
  });

  it('REDUCE conserva una imagen uniforme y divide el tamaño por dos', () => {
    const reduced = reduceGaussianLevel(createFlatImage(96, 128, 3, 77));
    expect(reduced.width).toBe(48);
    expect(reduced.height).toBe(64);
    for (const value of reduced.pixels) expect(value).toBeCloseTo(77, 4);
    const twiceReduced = reduceGaussianLevels(createFlatImage(96, 128, 1, 5), 2);
    expect([twiceReduced.width, twiceReduced.height]).toEqual([24, 32]);
  });

  it('REDUCE conserva la media y suaviza un tablero de ajedrez fino', () => {
    const checkerboard = createFlatImage(32, 32, 1, 0);
    for (let row = 0; row < 32; row++) {
      for (let column = 0; column < 32; column++) {
        checkerboard.pixels[row * 32 + column] = (row + column) % 2 === 0 ? 200 : 0;
      }
    }
    const reduced = reduceGaussianLevel(checkerboard);
    // El núcleo binomial anula la frecuencia de Nyquist: queda la media (100) en el interior.
    expect(reduced.pixels[5 * 16 + 5]).toBeCloseTo(100, 4);
  });

  it('luminancia, bytes y tamaño de la rejilla base', () => {
    const rgbImage: GridImage = { pixels: Float32Array.from([255, 255, 255, 300, -4, 0]), width: 2, height: 1, channelCount: 3 };
    expect(convertToLuminance(rgbImage).pixels[0]).toBeCloseTo(255, 3);
    expect(Array.from(convertToRgbBytes(rgbImage))).toEqual([255, 255, 255, 255, 0, 0]);
    expect(chooseBaseGridSize(480, 640, 128)).toEqual({ gridWidth: 96, gridHeight: 128 });
    expect(chooseBaseGridSize(640, 480, 128)).toEqual({ gridWidth: 128, gridHeight: 96 });
    expect(chooseBaseGridSize(1080, 1920, 128)).toEqual({ gridWidth: 72, gridHeight: 128 });
  });
});

describe('pasabanda por píxel', () => {
  const sampleRateHz = 30;

  function bandpassAmplitude(frequencyHz: number, lowCutoffHz = 0.8, highCutoffHz = 3): number {
    const bandpassFilter = createPixelBandpassFilter(1, lowCutoffHz, highCutoffHz, sampleRateHz);
    const outputValue = new Float64Array(1);
    let peakAfterSettling = 0;
    const sampleCount = sampleRateHz * 40;
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
      const inputValue = 100 + Math.sin((2 * Math.PI * frequencyHz * sampleIndex) / sampleRateHz);
      filterPixelFrame(bandpassFilter, [inputValue], outputValue);
      if (sampleIndex > sampleCount / 2) peakAfterSettling = Math.max(peakAfterSettling, Math.abs(outputValue[0]!));
    }
    return peakAfterSettling;
  }

  it('deja pasar la banda del pulso y atenúa lo que queda fuera', () => {
    expect(bandpassAmplitude(1.5)).toBeGreaterThan(0.9);
    expect(bandpassAmplitude(1.5)).toBeLessThan(1.05);
    expect(bandpassAmplitude(0.1)).toBeLessThan(0.01);
    expect(bandpassAmplitude(10)).toBeLessThan(0.05);
  });

  it('la frecuencia superior se limita por debajo de Nyquist', () => {
    const bandpassFilter = createPixelBandpassFilter(1, 2, 20, sampleRateHz);
    expect(bandpassFilter.highCutoffHz).toBeCloseTo(13.5);
    expect(() => createPixelBandpassFilter(1, 14, 20, sampleRateHz)).toThrow(RangeError);
  });

  it('el primer fotograma inicializa el estado: sin escalón por el nivel de continua', () => {
    const bandpassFilter = createPixelBandpassFilter(2, 0.8, 3, sampleRateHz);
    const outputValues = new Float32Array(2);
    for (let frameIndex = 0; frameIndex < 60; frameIndex++) {
      filterPixelFrame(bandpassFilter, [180, 40], outputValues);
      expect(Math.abs(outputValues[0]!)).toBeLessThan(1e-6);
      expect(Math.abs(outputValues[1]!)).toBeLessThan(1e-6);
    }
    resetPixelBandpassFilter(bandpassFilter);
    expect(bandpassFilter.isPrimed).toBe(false);
  });

  it('cada píxel equivale a la cascada de biquads de src/processing/dsp', () => {
    const bandpassFilter = createPixelBandpassFilter(3, 0.5, 4, sampleRateHz);
    const referenceStates = [0, 1, 2].map(() => bandpassFilter.sections.map(() => createBiquadState()));
    const outputValues = new Float64Array(3);
    const generateNoise = createNoiseGenerator(7);
    // Estado inicial a cero en los dos: se ceba con un fotograma nulo.
    filterPixelFrame(bandpassFilter, [0, 0, 0], outputValues);
    for (let frameIndex = 0; frameIndex < 200; frameIndex++) {
      const inputValues = [generateNoise(), generateNoise() * 10, Math.sin(frameIndex / 3)];
      filterPixelFrame(bandpassFilter, inputValues, outputValues);
      inputValues.forEach((inputValue, valueIndex) => {
        let referenceValue = inputValue;
        bandpassFilter.sections.forEach((coefficients, sectionIndex) => {
          referenceValue = processBiquadSample(coefficients, referenceStates[valueIndex]![sectionIndex]!, referenceValue);
        });
        expect(outputValues[valueIndex]).toBeCloseTo(referenceValue, 9);
      });
    }
  });
});

describe('tiempos de los fotogramas', () => {
  it('deduce la unidad de la marca de tiempo', () => {
    expect(detectTimestampSecondsPerUnit(33_333_333)).toBe(1e-9);
    expect(detectTimestampSecondsPerUnit(33_333)).toBe(1e-6);
    expect(detectTimestampSecondsPerUnit(33.3)).toBe(1e-3);
    expect(detectTimestampSecondsPerUnit(0.0333)).toBe(1);
  });

  it('pasa nanosegundos a segundos y estima la cadencia con la mediana', () => {
    const frameClock = createFrameClock();
    const baseTimestamp = 987_654_321_000;
    expect(frameClock.toSeconds(baseTimestamp)).toBeNull();
    let lastSeconds = 0;
    for (let frameIndex = 1; frameIndex <= 40; frameIndex++) {
      // Un fotograma de cada diez llega tarde: la mediana lo ignora.
      const jitterNanoseconds = frameIndex % 10 === 0 ? 8_000_000 : 0;
      lastSeconds = frameClock.toSeconds(baseTimestamp + frameIndex * 33_333_333 + jitterNanoseconds) ?? -1;
    }
    expect(lastSeconds).toBeCloseTo((40 * 33_333_333 + 8_000_000) / 1e9, 6);
    expect(frameClock.estimatedFramesPerSecond()).toBeCloseTo(30, 0);
    // Una marca repetida (fotograma duplicado) no cuenta.
    expect(frameClock.toSeconds(baseTimestamp + 40 * 33_333_333 + 8_000_000)).toBeNull();
  });

  it('con segundos (iOS) también funciona', () => {
    const frameClock = createFrameClock();
    frameClock.toSeconds(1000);
    for (let frameIndex = 1; frameIndex <= 20; frameIndex++) frameClock.toSeconds(1000 + frameIndex / 60);
    expect(frameClock.estimatedFramesPerSecond()).toBeCloseTo(60, 3);
  });
});

describe('medida de la frecuencia dominante', () => {
  /** Historia de una región: `valueForPixel(tiempo, píxel)` con fotogramas algo irregulares. */
  function buildHistory(
    durationSeconds: number,
    framesPerSecond: number,
    pixelCount: number,
    valueForPixel: (timeSeconds: number, pixelIndex: number) => number,
  ) {
    const history = createRegionHistory(Math.ceil(durationSeconds * framesPerSecond) + 1, pixelCount);
    const generateJitter = createNoiseGenerator(3);
    const frameCount = Math.floor(durationSeconds * framesPerSecond);
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
      const timeSeconds = (frameIndex + 0.15 * generateJitter()) / framesPerSecond;
      const frameValues = Array.from({ length: pixelCount }, (_, pixelIndex) => valueForPixel(timeSeconds, pixelIndex));
      pushRegionFrame(history, timeSeconds, frameValues);
    }
    return history;
  }

  it('pulso: encuentra 72 lpm en un cambio de color débil y ruidoso (coherente)', () => {
    const generateNoise = createNoiseGenerator(11);
    const pulseFrequencyHz = 1.2;
    const history = buildHistory(12, 30, 64, (timeSeconds) =>
      0.3 * Math.sin(2 * Math.PI * pulseFrequencyHz * timeSeconds) + 2 * generateNoise() + 0.05 * timeSeconds,
    );
    const estimate = estimateDominantFrequency(history, {
      minimumFrequencyHz: 0.8,
      maximumFrequencyHz: 3,
      combination: 'coherent',
    });
    expect(estimate).not.toBeNull();
    expect(convertFrequencyToDisplayUnit(estimate!.frequencyHz, 'beatsPerMinute')).toBeCloseTo(72, -0.5);
    expect(Math.abs(estimate!.frequencyHz - pulseFrequencyHz)).toBeLessThan(0.04);
    expect(estimate!.peakToMedianPowerRatio).toBeGreaterThan(6);
    expect(estimate!.sampleRateHz).toBeCloseTo(30, 0);
  });

  it('movimiento: suma potencias de bordes con fases distintas (incoherente)', () => {
    const generateNoise = createNoiseGenerator(5);
    const vibrationFrequencyHz = 6.5;
    // La mitad de los píxeles son bordes que oscilan con fases opuestas; al promediarlos se
    // cancelarían. El resto, solo ruido.
    const history = buildHistory(8, 30, 40, (timeSeconds, pixelIndex) => {
      const edgePhase = pixelIndex % 2 === 0 ? 0 : Math.PI;
      const edgeAmplitude = pixelIndex < 20 ? 1.5 : 0;
      return edgeAmplitude * Math.sin(2 * Math.PI * vibrationFrequencyHz * timeSeconds + edgePhase) + generateNoise();
    });
    const incoherentEstimate = estimateDominantFrequency(history, {
      minimumFrequencyHz: 2,
      maximumFrequencyHz: 12,
      combination: 'incoherent',
      strongestSeriesCount: 16,
    });
    expect(incoherentEstimate!.frequencyHz).toBeCloseTo(vibrationFrequencyHz, 1);
    expect(incoherentEstimate!.peakToMedianPowerRatio).toBeGreaterThan(10);

    const coherentEstimate = estimateDominantFrequency(history, {
      minimumFrequencyHz: 2,
      maximumFrequencyHz: 12,
      combination: 'coherent',
    });
    // Promediando, las fases opuestas se anulan y el pico se pierde entre el ruido.
    expect(coherentEstimate!.peakToMedianPowerRatio).toBeLessThan(incoherentEstimate!.peakToMedianPowerRatio / 3);
  });

  it('respiración: 15 rpm en la ventana de 30 s', () => {
    const history = buildHistory(30, 30, 4, (timeSeconds, pixelIndex) =>
      Math.sin(2 * Math.PI * 0.25 * timeSeconds + pixelIndex),
    );
    const estimate = estimateDominantFrequency(history, {
      minimumFrequencyHz: 0.1,
      maximumFrequencyHz: 0.7,
      combination: 'incoherent',
    });
    expect(convertFrequencyToDisplayUnit(estimate!.frequencyHz, 'breathsPerMinute')).toBeCloseTo(15, 0);
  });

  it('solo analiza la ventana pedida y no mide con poca historia', () => {
    const history = buildHistory(20, 30, 1, (timeSeconds) =>
      Math.sin(2 * Math.PI * (timeSeconds < 10 ? 1 : 2) * timeSeconds),
    );
    const recentEstimate = estimateDominantFrequency(history, {
      minimumFrequencyHz: 0.8,
      maximumFrequencyHz: 3,
      combination: 'coherent',
      windowSeconds: 8,
    });
    expect(recentEstimate!.frequencyHz).toBeCloseTo(2, 1);
    expect(recentEstimate!.durationSeconds).toBeLessThanOrEqual(8);

    const shortHistory = buildHistory(1, 30, 1, () => 0);
    expect(
      estimateDominantFrequency(shortHistory, { minimumFrequencyHz: 0.8, maximumFrequencyHz: 3, combination: 'coherent' }),
    ).toBeNull();
  });

  it('extrae la región central de un canal', () => {
    // Rejilla 6×3 de dos canales: el valor del canal 1 es el índice del píxel.
    const gridPixels = new Float32Array(6 * 3 * 2);
    for (let pixelIndex = 0; pixelIndex < 18; pixelIndex++) gridPixels[pixelIndex * 2 + 1] = pixelIndex;
    expect(Array.from(extractCentralRegion(gridPixels, 6, 3, 2, 1, 1 / 3))).toEqual([8, 9]);
  });
});

describe('amplificación y mapa', () => {
  it('suma α·variación (ampliada a la base) y respeta el tope', () => {
    const baseRgb = new Uint8Array(4 * 4 * 3).fill(100);
    const filteredLevel = new Float32Array(2 * 2).fill(0.5);
    const outputRgba = new Uint8Array(4 * 4 * 4);
    reconstructAmplifiedRgba(baseRgb, 4, 4, filteredLevel, 2, 2, 1, { amplificationFactor: 20, maximumAddedLevels: 50 }, outputRgba);
    expect(Array.from(outputRgba.slice(0, 8))).toEqual([110, 110, 110, 255, 110, 110, 110, 255]);

    reconstructAmplifiedRgba(baseRgb, 4, 4, filteredLevel, 2, 2, 1, { amplificationFactor: 400, maximumAddedLevels: 50 }, outputRgba);
    expect(outputRgba[0]).toBe(150);
  });

  it('interpola la variación entre los píxeles del nivel grueso', () => {
    const baseRgb = new Uint8Array(4 * 1 * 3).fill(100);
    // Variación RGB: izquierda −1, derecha +1 (en los tres canales).
    const filteredLevel = Float32Array.from([-1, -1, -1, 1, 1, 1]);
    const outputRgba = new Uint8Array(4 * 4);
    reconstructAmplifiedRgba(baseRgb, 4, 1, filteredLevel, 2, 1, 3, { amplificationFactor: 10, maximumAddedLevels: 100 }, outputRgba);
    const redValues = [0, 1, 2, 3].map((pixelIndex) => outputRgba[pixelIndex * 4]);
    expect(redValues).toEqual([90, 95, 105, 110]);
  });

  it('el mapa es cálido donde sube, frío donde baja y transparente sin cambio', () => {
    const filteredLevel = Float32Array.from([2, -2, 0]);
    const overlayRgba = new Uint8Array(3 * 4);
    renderVariationOverlayRgba(filteredLevel, 3, 1, 1, { amplificationFactor: 50, maximumAddedLevels: 50 }, overlayRgba);
    expect(overlayRgba[0]).toBeGreaterThan(overlayRgba[2]!);
    expect(overlayRgba[3]).toBeGreaterThan(200);
    expect(overlayRgba[6]).toBeGreaterThan(overlayRgba[4]!);
    expect(overlayRgba[11]).toBe(0);
  });
});

describe('bandas', () => {
  it('limita la banda por la cadencia de la cámara', () => {
    expect(resolveEffectiveBand(2, 14, 30)).toEqual({ lowCutoffHz: 2, highCutoffHz: 13.5, isHighCutoffLimited: true });
    expect(resolveEffectiveBand(0.8, 3, 30)?.isHighCutoffLimited).toBe(false);
    expect(resolveEffectiveBand(8, 14, 15)).toBeNull();
    expect(magnificationBandPresets.pulse.displayUnit).toBe('beatsPerMinute');
  });
});

describe('motor de amplificación', () => {
  /**
   * Vídeo sintético (nanosegundos, 30 fotogramas/s): una «cara» cuyo verde late a 1,2 Hz con
   * amplitud 0,4 niveles, más ruido de cámara. Nivel grueso de 6×8, base de 12×16.
   */
  function createSyntheticPulseFrame(frameIndex: number, generateNoise: () => number): GridFrame {
    const timeSeconds = frameIndex / 30;
    const pulseLevels = 0.4 * Math.sin(2 * Math.PI * 1.2 * timeSeconds);
    const levelPixels = new Float32Array(6 * 8 * 3);
    for (let pixelIndex = 0; pixelIndex < 48; pixelIndex++) {
      levelPixels[pixelIndex * 3] = 150 + 0.3 * generateNoise();
      levelPixels[pixelIndex * 3 + 1] = 110 + pulseLevels + 0.3 * generateNoise();
      levelPixels[pixelIndex * 3 + 2] = 90 + 0.3 * generateNoise();
    }
    const baseRgb = new Uint8Array(12 * 16 * 3);
    for (let pixelIndex = 0; pixelIndex < 12 * 16; pixelIndex++) {
      baseRgb.set([150, 110, 90], pixelIndex * 3);
    }
    return {
      rawTimestamp: 5_000_000_000 + frameIndex * 33_333_333,
      baseRgb,
      baseWidth: 12,
      baseHeight: 16,
      levelPixels,
      levelWidth: 6,
      levelHeight: 8,
      levelChannelCount: 3,
    };
  }

  it('amplifica el pulso hasta hacerlo visible y lo mide en lpm', () => {
    const preset = magnificationBandPresets.pulse;
    const magnificationEngine = createMagnificationEngine({
      lowCutoffHz: preset.defaultLowCutoffHz,
      highCutoffHz: preset.defaultHighCutoffHz,
      amplifiedSignal: preset.amplifiedSignal,
      amplificationFactor: 50,
      maximumAddedLevels: preset.maximumAddedLevels,
      measurementWindowSeconds: preset.measurementWindowSeconds,
      pixelCombination: preset.pixelCombination,
    });
    const generateNoise = createNoiseGenerator(21);
    const outputRequest = { wantsAmplifiedImage: true, wantsOverlay: true };

    const firstFrame = magnificationEngine.processFrame(createSyntheticPulseFrame(0, generateNoise), outputRequest);
    expect(firstFrame.status).toBe('estimatingFrameRate');
    expect(firstFrame.amplifiedRgba?.[1]).toBe(110);
    expect(magnificationEngine.estimateFrequency()).toBeNull();

    let minimumGreen = 255;
    let maximumGreen = 0;
    let lastStatus = '';
    for (let frameIndex = 1; frameIndex < 30 * 20; frameIndex++) {
      const processedFrame = magnificationEngine.processFrame(createSyntheticPulseFrame(frameIndex, generateNoise), outputRequest);
      lastStatus = processedFrame.status;
      if (frameIndex > 30 * 10) {
        const centerGreen = processedFrame.amplifiedRgba![(8 * 12 + 6) * 4 + 1]!;
        minimumGreen = Math.min(minimumGreen, centerGreen);
        maximumGreen = Math.max(maximumGreen, centerGreen);
      }
    }
    expect(lastStatus).toBe('running');
    // 0,8 niveles de pico a pico ×50 ≈ 40 niveles: a simple vista.
    expect(maximumGreen - minimumGreen).toBeGreaterThan(25);

    const estimate = magnificationEngine.estimateFrequency();
    expect(estimate).not.toBeNull();
    expect(estimate!.frequencyHz * 60).toBeGreaterThan(69);
    expect(estimate!.frequencyHz * 60).toBeLessThan(75);
    expect(magnificationEngine.measurementProgress().storedSeconds).toBeCloseTo(preset.measurementWindowSeconds, 0);
  });

  it('al reiniciar la ventana de medida la vacía y espera a que el filtro se asiente', () => {
    const preset = magnificationBandPresets.pulse;
    const magnificationEngine = createMagnificationEngine({
      lowCutoffHz: preset.defaultLowCutoffHz,
      highCutoffHz: preset.defaultHighCutoffHz,
      amplifiedSignal: preset.amplifiedSignal,
      amplificationFactor: 50,
      maximumAddedLevels: preset.maximumAddedLevels,
      measurementWindowSeconds: preset.measurementWindowSeconds,
      pixelCombination: preset.pixelCombination,
    });
    const generateNoise = createNoiseGenerator(5);
    const outputRequest = { wantsAmplifiedImage: false, wantsOverlay: false };
    let frameIndex = 0;
    for (; frameIndex < 30 * 20; frameIndex++) {
      magnificationEngine.processFrame(createSyntheticPulseFrame(frameIndex, generateNoise), outputRequest);
    }
    expect(magnificationEngine.estimateFrequency()).not.toBeNull();

    magnificationEngine.restartMeasurementWindow();
    expect(magnificationEngine.measurementProgress().storedSeconds).toBe(0);
    expect(magnificationEngine.estimateFrequency()).toBeNull();
    // Durante el asentamiento (2 s) no se guarda nada, aunque la vista siga funcionando.
    for (const lastFrameIndex = frameIndex + 30; frameIndex < lastFrameIndex; frameIndex++) {
      expect(
        magnificationEngine.processFrame(createSyntheticPulseFrame(frameIndex, generateNoise), outputRequest).status,
      ).toBe('running');
    }
    expect(magnificationEngine.measurementProgress().storedSeconds).toBe(0);
    for (const lastFrameIndex = frameIndex + 30 * 20; frameIndex < lastFrameIndex; frameIndex++) {
      magnificationEngine.processFrame(createSyntheticPulseFrame(frameIndex, generateNoise), outputRequest);
    }
    expect(magnificationEngine.estimateFrequency()!.frequencyHz * 60).toBeCloseTo(72, -1);
  });

  it('avisa si la banda no cabe con la cadencia de la cámara', () => {
    const magnificationEngine = createMagnificationEngine({
      lowCutoffHz: 14,
      highCutoffHz: 16,
      amplifiedSignal: 'luminance',
      amplificationFactor: 10,
      maximumAddedLevels: 80,
      measurementWindowSeconds: 8,
      pixelCombination: 'incoherent',
    });
    const generateNoise = createNoiseGenerator(1);
    let lastStatus = '';
    for (let frameIndex = 0; frameIndex < 40; frameIndex++) {
      lastStatus = magnificationEngine.processFrame(createSyntheticPulseFrame(frameIndex, generateNoise), {
        wantsAmplifiedImage: false,
        wantsOverlay: false,
      }).status;
    }
    expect(lastStatus).toBe('bandAboveFrameRate');
  });
});

import { useCallback, useLayoutEffect, useRef } from 'react';
import { CommonResolutions, type Frame, useFrameOutput } from 'react-native-vision-camera';
import { scheduleOnRN } from 'react-native-worklets';

import { readFramePixels } from '@/core/camera/framePixels';
import {
  accumulateBrightnessHistogram,
  defaultParticleDetectionOptions,
  detectParticleEventsInFrame,
  findSeedPixels,
  type FrameDetectionResult,
  type FramePixelLayout,
  sampleDarkLevel,
} from '@/processing/particles/darkFrameEvents';

/**
 * Qué se hace con cada fotograma:
 * - `monitor`: solo el nivel de negro (para saber si la cámara está bien tapada).
 * - `noiseCalibration`: histograma del brillo, para medir el ruido.
 * - `hotPixelCalibration`: píxeles por encima del umbral, sin máscara, para encontrar los calientes.
 * - `measuring`: detección de sucesos con la máscara.
 */
export type DarkFrameMode = 'monitor' | 'noiseCalibration' | 'hotPixelCalibration' | 'measuring';

export interface FrameSize {
  frameWidth: number;
  frameHeight: number;
}

export interface DarkFrameHandlers {
  onMonitor(darkLevel: number, frameSize: FrameSize): void;
  onNoiseHistogram(histogram: Uint32Array, darkLevel: number, frameSize: FrameSize): void;
  onHotPixelFrame(pixelIndices: number[], isOverflowing: boolean, darkLevel: number, frameSize: FrameSize): void;
  onDetection(detection: FrameDetectionResult, frameSize: FrameSize): void;
}

/** Salto de píxeles del histograma de calibración: una muestra de cada 4 basta para el ruido. */
const histogramSampleStride = 2;
/** Píxeles máximos por fotograma en la búsqueda de calientes; más significa que entra luz. */
const maximumHotPixelCandidatesPerFrame = 5000;
/** Avisos de nivel de negro por segundo en modo `monitor`. */
const maximumMonitorUpdatesPerSecond = 4;

/**
 * Lee los fotogramas de la cámara tapada en su propio hilo y entrega al hilo JS solo lo necesario
 * (unas cifras, un histograma o los sucesos con sus miniaturas). Se usa la resolución más alta
 * razonable: el sistema reduce la imagen del sensor y, al promediar píxeles, diluye el brillo de
 * un impacto que ocupa uno o dos píxeles del sensor.
 */
export function useDarkFrames(
  mode: DarkFrameMode,
  thresholdOffset: number,
  hotPixelIndices: Int32Array,
  handlers: DarkFrameHandlers,
) {
  // Los manejadores cambian en cada render; el worklet llama siempre a los mismos puentes.
  const handlersRef = useRef(handlers);
  useLayoutEffect(() => {
    handlersRef.current = handlers;
  });
  const lastMonitorUpdateTime = useRef(0);

  const deliverMonitor = useCallback((darkLevel: number, frameSize: FrameSize) => {
    const currentTime = Date.now();
    if (currentTime - lastMonitorUpdateTime.current < 1000 / maximumMonitorUpdatesPerSecond) return;
    lastMonitorUpdateTime.current = currentTime;
    handlersRef.current.onMonitor(darkLevel, frameSize);
  }, []);
  const deliverNoiseHistogram = useCallback((histogram: Uint32Array, darkLevel: number, frameSize: FrameSize) => {
    handlersRef.current.onNoiseHistogram(histogram, darkLevel, frameSize);
  }, []);
  const deliverHotPixelFrame = useCallback(
    (pixelIndices: number[], isOverflowing: boolean, darkLevel: number, frameSize: FrameSize) => {
      handlersRef.current.onHotPixelFrame(pixelIndices, isOverflowing, darkLevel, frameSize);
    },
    [],
  );
  const deliverDetection = useCallback((detection: FrameDetectionResult, frameSize: FrameSize) => {
    handlersRef.current.onDetection(detection, frameSize);
  }, []);

  const handleFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      const framePixels = readFramePixels(frame);
      if (!framePixels) {
        frame.dispose();
        return;
      }
      const layout: FramePixelLayout = {
        frameWidth: framePixels.width,
        frameHeight: framePixels.height,
        bytesPerRow: framePixels.bytesPerRow,
        bytesPerPixel: framePixels.bytesPerPixel,
      };
      const frameSize: FrameSize = { frameWidth: layout.frameWidth, frameHeight: layout.frameHeight };
      const pixels = framePixels.pixels;

      if (mode === 'measuring') {
        const detection = detectParticleEventsInFrame(pixels, layout, hotPixelIndices, {
          ...defaultParticleDetectionOptions,
          thresholdOffset,
        });
        frame.dispose();
        scheduleOnRN(deliverDetection, detection, frameSize);
        return;
      }

      const darkLevel = sampleDarkLevel(pixels, layout, defaultParticleDetectionOptions.darkLevelSampleStride);
      if (mode === 'noiseCalibration') {
        const histogram = new Uint32Array(256);
        accumulateBrightnessHistogram(pixels, layout, histogramSampleStride, histogram);
        frame.dispose();
        scheduleOnRN(deliverNoiseHistogram, histogram, darkLevel, frameSize);
        return;
      }
      if (mode === 'hotPixelCalibration') {
        const seedSearch = findSeedPixels(
          pixels,
          layout,
          darkLevel + thresholdOffset,
          new Int32Array(0),
          maximumHotPixelCandidatesPerFrame,
        );
        frame.dispose();
        scheduleOnRN(deliverHotPixelFrame, seedSearch.seedIndices, seedSearch.isOverflowing, darkLevel, frameSize);
        return;
      }
      frame.dispose();
      scheduleOnRN(deliverMonitor, darkLevel, frameSize);
    },
    [
      mode,
      thresholdOffset,
      hotPixelIndices,
      deliverDetection,
      deliverNoiseHistogram,
      deliverHotPixelFrame,
      deliverMonitor,
    ],
  );

  return useFrameOutput({
    // FHD: el mejor compromiso entre dilución del impacto y tiempo de cálculo por fotograma.
    targetResolution: CommonResolutions.FHD_4_3,
    pixelFormat: 'rgb',
    onFrame: handleFrame,
  });
}

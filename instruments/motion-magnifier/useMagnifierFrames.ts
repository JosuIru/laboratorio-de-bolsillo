import { useCallback, useEffect, useRef } from 'react';
import { CommonResolutions, type Frame, useFrameOutput } from 'react-native-vision-camera';
import { scheduleOnRN } from 'react-native-worklets';

import { readFramePixels } from '@/core/camera/framePixels';
import type { AmplifiedSignal } from '@/processing/eulerian/bands';
import {
  chooseBaseGridSize,
  convertToLuminance,
  convertToRgbBytes,
  downsampleFrameByBlockAverage,
  reduceGaussianLevels,
} from '@/processing/eulerian/gaussianPyramid';
import type { GridFrame } from '@/processing/eulerian/magnificationEngine';

/** Lado largo de la rejilla base (96 × 128 con fotogramas 3:4). Los niveles: 48 × 64 y 24 × 32. */
export const baseGridLongSidePixels = 128;
/** Dentro de cada bloque se lee un píxel de cada dos (en filas y columnas): la cuarta parte. */
const blockSampleStride = 2;

export interface DeliveredGridFrame extends GridFrame {
  frameWidth: number;
  frameHeight: number;
}

/**
 * Procesa cada fotograma en el hilo de la cámara (worklet): lo reduce por promedio de bloques a
 * la rejilla base, baja `pyramidReductionCount` niveles de la pirámide gaussiana y, si se
 * amplifica el movimiento, pasa el nivel a luminancia. Al hilo JS solo llegan esas dos imágenes
 * pequeñas (≈ 37 kB + 9-37 kB por fotograma), no el fotograma entero.
 */
export function useMagnifierFrames(
  pyramidReductionCount: number,
  amplifiedSignal: AmplifiedSignal,
  onGridFrame: (gridFrame: DeliveredGridFrame) => void,
) {
  const latestGridFrameHandler = useRef(onGridFrame);
  useEffect(() => {
    latestGridFrameHandler.current = onGridFrame;
  }, [onGridFrame]);

  const deliverGridFrame = useCallback((gridFrame: DeliveredGridFrame) => {
    latestGridFrameHandler.current(gridFrame);
  }, []);

  const handleFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      const framePixels = readFramePixels(frame);
      if (!framePixels) {
        frame.dispose();
        return;
      }
      const rawTimestamp = frame.timestamp;
      const { pixels, width: frameWidth, height: frameHeight, bytesPerRow, bytesPerPixel, pixelLayout } = framePixels;
      const { gridWidth, gridHeight } = chooseBaseGridSize(frameWidth, frameHeight, baseGridLongSidePixels);
      const baseImage = downsampleFrameByBlockAverage(
        pixels,
        frameWidth,
        frameHeight,
        bytesPerRow,
        bytesPerPixel,
        pixelLayout === 'bgra',
        gridWidth,
        gridHeight,
        blockSampleStride,
      );
      // Los píxeles ya están copiados en la rejilla: el fotograma se puede liberar.
      frame.dispose();

      const reducedRgbLevel = reduceGaussianLevels(baseImage, pyramidReductionCount);
      const processedLevel = amplifiedSignal === 'luminance' ? convertToLuminance(reducedRgbLevel) : reducedRgbLevel;
      scheduleOnRN(deliverGridFrame, {
        rawTimestamp,
        baseRgb: convertToRgbBytes(baseImage),
        baseWidth: baseImage.width,
        baseHeight: baseImage.height,
        levelPixels: processedLevel.pixels,
        levelWidth: processedLevel.width,
        levelHeight: processedLevel.height,
        levelChannelCount: processedLevel.channelCount === 1 ? 1 : 3,
        frameWidth,
        frameHeight,
      });
    },
    [pyramidReductionCount, amplifiedSignal, deliverGridFrame],
  );

  return useFrameOutput({
    // Resolución baja: la rejilla es de 96 × 128 y así el promedio de bloques es ligero.
    targetResolution: CommonResolutions.VGA_4_3,
    pixelFormat: 'rgb',
    // Fotogramas ya derechos: la imagen amplificada sale con la orientación de la vista previa.
    enablePhysicalBufferRotation: true,
    onFrame: handleFrame,
  });
}

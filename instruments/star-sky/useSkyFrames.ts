import { useCallback, useLayoutEffect, useRef } from 'react';
import { CommonResolutions, type Frame, useFrameOutput } from 'react-native-vision-camera';
import { scheduleOnRN } from 'react-native-worklets';

import { readFramePixels } from '@/core/camera/framePixels';

/** Cada lado del fotograma se reduce este factor (bloques de 2×2 promediados). */
const frameDownsampleFactor = 2;
/** Fotogramas por segundo, como mucho, que se analizan en el hilo JS. */
const maximumFramesPerSecond = 8;
/** Fotogramas más viejos que esto al llegar al hilo JS se descartan. */
const maximumFrameAgeMilliseconds = 1500;

export interface SkyFrame {
  grayBytes: Uint8Array;
  width: number;
  height: number;
  /** Hora del reloj al llegar el fotograma al hilo de la cámara. */
  wallClockMilliseconds: number;
}

/**
 * Luminancia reducida de un fotograma (worklet). La luminancia aproximada (R + 2G + B)/4 vale
 * igual para RGBA y BGRA.
 */
function copyDownsampledGray(
  pixels: Uint8Array,
  frameWidth: number,
  frameHeight: number,
  bytesPerRow: number,
  bytesPerPixel: number,
  downsampleFactor: number,
): Uint8Array {
  'worklet';
  const outputWidth = Math.floor(frameWidth / downsampleFactor);
  const outputHeight = Math.floor(frameHeight / downsampleFactor);
  const grayBytes = new Uint8Array(outputWidth * outputHeight);
  const samplesPerBlock = downsampleFactor * downsampleFactor;
  for (let outputRow = 0; outputRow < outputHeight; outputRow++) {
    for (let outputColumn = 0; outputColumn < outputWidth; outputColumn++) {
      let brightnessSum = 0;
      for (let blockRow = 0; blockRow < downsampleFactor; blockRow++) {
        const rowOffset = (outputRow * downsampleFactor + blockRow) * bytesPerRow;
        for (let blockColumn = 0; blockColumn < downsampleFactor; blockColumn++) {
          const pixelOffset = rowOffset + (outputColumn * downsampleFactor + blockColumn) * bytesPerPixel;
          brightnessSum += (pixels[pixelOffset]! + 2 * pixels[pixelOffset + 1]! + pixels[pixelOffset + 2]!) / 4;
        }
      }
      grayBytes[outputRow * outputWidth + outputColumn] = Math.round(brightnessSum / samplesPerBlock);
    }
  }
  return grayBytes;
}

/**
 * Fotogramas del flujo de vídeo para vigilar meteoros: solo mientras `isWatching`, reducidos a
 * luminancia en el hilo de la cámara (el fotograma entero nunca llega al hilo JS).
 */
export function useSkyFrames(isWatching: boolean, onFrame: (skyFrame: SkyFrame) => void) {
  // En una ref para no recrear la salida de fotogramas cada vez que cambia la función.
  const onFrameRef = useRef(onFrame);
  useLayoutEffect(() => {
    onFrameRef.current = onFrame;
  });
  const lastDeliveryTime = useRef(0);

  const deliverFrame = useCallback((grayBytes: Uint8Array, width: number, height: number, wallClockMilliseconds: number) => {
    // Si el hilo JS va retrasado, los fotogramas se acumulan: se descartan los viejos y los que
    // llegan demasiado seguidos.
    if (Date.now() - wallClockMilliseconds > maximumFrameAgeMilliseconds) return;
    if (wallClockMilliseconds - lastDeliveryTime.current < 1000 / maximumFramesPerSecond) return;
    lastDeliveryTime.current = wallClockMilliseconds;
    onFrameRef.current({ grayBytes, width, height, wallClockMilliseconds });
  }, []);

  const handleFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      if (!isWatching) {
        frame.dispose();
        return;
      }
      const wallClockMilliseconds = Date.now();
      const framePixels = readFramePixels(frame);
      if (!framePixels) {
        frame.dispose();
        return;
      }
      const grayBytes = copyDownsampledGray(
        framePixels.pixels,
        framePixels.width,
        framePixels.height,
        framePixels.bytesPerRow,
        framePixels.bytesPerPixel,
        frameDownsampleFactor,
      );
      const outputWidth = Math.floor(framePixels.width / frameDownsampleFactor);
      const outputHeight = Math.floor(framePixels.height / frameDownsampleFactor);
      frame.dispose();
      scheduleOnRN(deliverFrame, grayBytes, outputWidth, outputHeight, wallClockMilliseconds);
    },
    [deliverFrame, isWatching],
  );

  return useFrameOutput({
    targetResolution: CommonResolutions.HD_4_3,
    pixelFormat: 'rgb',
    // Fotogramas ya derechos, como la vista previa.
    enablePhysicalBufferRotation: true,
    onFrame: handleFrame,
  });
}

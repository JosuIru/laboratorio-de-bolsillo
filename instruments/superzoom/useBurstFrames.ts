import { useCallback, useEffect, useRef, useState } from 'react';
import { CommonResolutions, type Frame, useFrameOutput } from 'react-native-vision-camera';
import { scheduleOnRN } from 'react-native-worklets';

import { readFramePixels } from '@/core/camera/framePixels';
import { copyCenteredCrop } from '@/processing/image/lunarStacking';

/** Si en este tiempo no se reúnen los fotogramas pedidos, se fusiona lo que haya. */
const maximumCaptureMilliseconds = 10_000;
/** Cada cuánto se avisa al hilo JS del tamaño del fotograma (para dibujar el recuadro). */
const frameSizeUpdateMilliseconds = 1000;

export interface FrameDimensions {
  frameWidth: number;
  frameHeight: number;
}

export interface BurstCaptureProgress {
  capturedFrameCount: number;
  targetFrameCount: number;
}

/**
 * Captura ráfagas de recortes cuadrados del centro de la imagen, en el hilo de la cámara. Sin
 * captura, solo envía de vez en cuando el tamaño del fotograma; durante la captura, copia en
 * cada fotograma el recorte central y lo envía al hilo JS, que los acumula.
 */
export function useBurstFrames() {
  const [frameDimensions, setFrameDimensions] = useState<FrameDimensions | null>(null);
  const [captureCropSize, setCaptureCropSize] = useState<number | null>(null);
  const [captureProgress, setCaptureProgress] = useState<BurstCaptureProgress | null>(null);
  const lastFrameSizeUpdateTime = useRef(0);
  const capturedFrames = useRef<Uint8Array[]>([]);
  const targetFrameCount = useRef(0);
  const resolveCapture = useRef<((frames: Uint8Array[]) => void) | null>(null);
  const captureTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const deliverFrameDimensions = useCallback((dimensions: FrameDimensions) => {
    const currentTime = Date.now();
    if (currentTime - lastFrameSizeUpdateTime.current < frameSizeUpdateMilliseconds) return;
    lastFrameSizeUpdateTime.current = currentTime;
    setFrameDimensions((previousDimensions) =>
      previousDimensions?.frameWidth === dimensions.frameWidth && previousDimensions.frameHeight === dimensions.frameHeight
        ? previousDimensions
        : dimensions,
    );
  }, []);

  const finishCapture = useCallback(() => {
    const resolveCaptureNow = resolveCapture.current;
    if (!resolveCaptureNow) return;
    resolveCapture.current = null;
    if (captureTimeout.current) clearTimeout(captureTimeout.current);
    captureTimeout.current = null;
    setCaptureCropSize(null);
    resolveCaptureNow(capturedFrames.current);
    capturedFrames.current = [];
  }, []);

  // Al salir de la pantalla se descarta la captura en curso: se borra el temporizador y quien
  // espera recibe una ráfaga vacía (y no se procesa nada en la pantalla siguiente).
  useEffect(
    () => () => {
      if (captureTimeout.current) clearTimeout(captureTimeout.current);
      captureTimeout.current = null;
      const resolveCaptureNow = resolveCapture.current;
      resolveCapture.current = null;
      capturedFrames.current = [];
      resolveCaptureNow?.([]);
    },
    [],
  );

  const deliverCrop = useCallback(
    (rgbPixels: Uint8Array) => {
      if (!resolveCapture.current) return;
      capturedFrames.current.push(rgbPixels);
      const capturedFrameCount = capturedFrames.current.length;
      setCaptureProgress({ capturedFrameCount, targetFrameCount: targetFrameCount.current });
      if (capturedFrameCount >= targetFrameCount.current) finishCapture();
    },
    [finishCapture],
  );

  const handleFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      const framePixels = readFramePixels(frame);
      if (!framePixels) {
        frame.dispose();
        return;
      }
      const { pixels, width: frameWidth, height: frameHeight, bytesPerRow, bytesPerPixel, pixelLayout } = framePixels;
      let rgbPixels: Uint8Array | null = null;
      if (captureCropSize !== null && captureCropSize <= Math.min(frameWidth, frameHeight)) {
        rgbPixels = new Uint8Array(captureCropSize * captureCropSize * 3);
        copyCenteredCrop(
          pixels,
          frameWidth,
          frameHeight,
          bytesPerRow,
          bytesPerPixel,
          pixelLayout === 'bgra',
          Math.floor((frameWidth - captureCropSize) / 2),
          Math.floor((frameHeight - captureCropSize) / 2),
          captureCropSize,
          rgbPixels,
        );
      }
      frame.dispose();

      if (rgbPixels) scheduleOnRN(deliverCrop, rgbPixels);
      scheduleOnRN(deliverFrameDimensions, { frameWidth, frameHeight });
    },
    [captureCropSize, deliverCrop, deliverFrameDimensions],
  );

  const frameOutput = useFrameOutput({
    // Resolución alta: el detalle está en los píxeles del recorte central.
    targetResolution: CommonResolutions.FHD_4_3,
    pixelFormat: 'rgb',
    // Fotogramas ya derechos: así el resultado sale con la misma orientación que la vista previa.
    enablePhysicalBufferRotation: true,
    onFrame: handleFrame,
  });

  /** Captura `frameCount` recortes centrales de lado `cropSize`. */
  const captureBurst = useCallback(
    (frameCount: number, cropSize: number) => {
      capturedFrames.current = [];
      targetFrameCount.current = frameCount;
      setCaptureProgress({ capturedFrameCount: 0, targetFrameCount: frameCount });
      setCaptureCropSize(cropSize);
      captureTimeout.current = setTimeout(finishCapture, maximumCaptureMilliseconds);
      return new Promise<Uint8Array[]>((resolve) => {
        resolveCapture.current = resolve;
      });
    },
    [finishCapture],
  );

  return {
    frameOutput,
    frameDimensions,
    isCapturing: captureCropSize !== null,
    captureProgress,
    captureBurst,
    /** Termina la captura en curso y entrega lo capturado hasta ahora. */
    stopCapture: finishCapture,
  };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { CommonResolutions, type Frame, useFrameOutput } from 'react-native-vision-camera';
import { scheduleOnRN } from 'react-native-worklets';

import { readFramePixels } from '@/core/camera/framePixels';
import {
  type AlignedCrop,
  type BrightObjectDetection,
  copyCenteredCrop,
  locateBrightObject,
  planCenteredCrop,
} from '@/processing/image/lunarStacking';

/** Detecciones por segundo que se envían al hilo JS mientras no se captura. */
const maximumDetectionsPerSecond = 4;
/** Salto de píxeles al buscar la Luna: con fotogramas de 1440×1920 basta y es mucho más ligero. */
const detectionSampleStride = 4;

export interface LiveMoonDetection extends BrightObjectDetection {
  frameWidth: number;
  frameHeight: number;
}

export interface CaptureProgress {
  capturedCropCount: number;
  targetCropCount: number;
  /** Fotogramas descartados porque el móvil se movía. */
  rejectedCropCount: number;
}

export interface CaptureResult {
  crops: AlignedCrop[];
  rejectedCropCount: number;
}

/** Si en este tiempo no se reúnen los fotogramas pedidos, se apila lo que haya. */
const maximumCaptureMilliseconds = 20_000;

/**
 * Procesa los fotogramas en el hilo de la cámara. Sin captura, localiza la Luna y envía unas
 * pocas cifras (posición, tamaño, saturación). Durante la captura, además recorta en cada
 * fotograma un cuadrado centrado en ella y lo envía al hilo JS, que lo acumula.
 * `onDetection` recibe cada detección que llega al hilo JS (para ajustar la exposición).
 */
export function useMoonFrames(isDeviceSteady: () => boolean, onDetection?: (detection: LiveMoonDetection) => void) {
  const [liveDetection, setLiveDetection] = useState<LiveMoonDetection | null>(null);
  const [captureCropSize, setCaptureCropSize] = useState<number | null>(null);
  const [captureProgress, setCaptureProgress] = useState<CaptureProgress | null>(null);
  const lastDetectionDeliveryTime = useRef(0);
  const capturedCrops = useRef<AlignedCrop[]>([]);
  const targetCropCount = useRef(0);
  const resolveCapture = useRef<((captureResult: CaptureResult) => void) | null>(null);
  const rejectedCropCount = useRef(0);
  const captureTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  // En una ref para no recrear la salida de fotogramas cada vez que cambia la función.
  const onDetectionRef = useRef(onDetection);
  useEffect(() => {
    onDetectionRef.current = onDetection;
  }, [onDetection]);

  const deliverDetection = useCallback((detection: LiveMoonDetection | null) => {
    const currentTime = Date.now();
    if (currentTime - lastDetectionDeliveryTime.current < 1000 / maximumDetectionsPerSecond) return;
    lastDetectionDeliveryTime.current = currentTime;
    setLiveDetection(detection);
    if (detection) onDetectionRef.current?.(detection);
  }, []);

  const finishCapture = useCallback(() => {
    const resolveCaptureNow = resolveCapture.current;
    if (!resolveCaptureNow) return;
    resolveCapture.current = null;
    if (captureTimeout.current) clearTimeout(captureTimeout.current);
    captureTimeout.current = null;
    setCaptureCropSize(null);
    resolveCaptureNow({ crops: capturedCrops.current, rejectedCropCount: rejectedCropCount.current });
    capturedCrops.current = [];
  }, []);

  const deliverCrop = useCallback(
    (crop: AlignedCrop) => {
      if (!resolveCapture.current) return;
      // Un fotograma tomado mientras el móvil se mueve sale corrido: no aporta, emborrona.
      if (isDeviceSteady()) capturedCrops.current.push(crop);
      else rejectedCropCount.current++;
      const capturedCropCount = capturedCrops.current.length;
      setCaptureProgress({
        capturedCropCount,
        targetCropCount: targetCropCount.current,
        rejectedCropCount: rejectedCropCount.current,
      });
      if (capturedCropCount >= targetCropCount.current) finishCapture();
    },
    [isDeviceSteady, finishCapture],
  );

  const handleFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      const framePixels = readFramePixels(frame);
      if (!framePixels) {
        frame.dispose();
        return;
      }
      const { pixels, bytesPerRow, bytesPerPixel } = framePixels;
      const isBgrOrder = framePixels.pixelLayout === 'bgra';
      const frameWidth = framePixels.width;
      const frameHeight = framePixels.height;
      const detection = locateBrightObject(pixels, frameWidth, frameHeight, bytesPerRow, bytesPerPixel, detectionSampleStride);

      let crop: AlignedCrop | null = null;
      if (captureCropSize !== null && detection) {
        const cropPlan = planCenteredCrop(detection.centerX, detection.centerY, captureCropSize);
        const rgbPixels = new Uint8Array(captureCropSize * captureCropSize * 3);
        copyCenteredCrop(
          pixels,
          frameWidth,
          frameHeight,
          bytesPerRow,
          bytesPerPixel,
          isBgrOrder,
          cropPlan.cropLeft,
          cropPlan.cropTop,
          captureCropSize,
          rgbPixels,
        );
        crop = {
          rgbPixels,
          fractionalOffsetX: cropPlan.fractionalOffsetX,
          fractionalOffsetY: cropPlan.fractionalOffsetY,
        };
      }
      frame.dispose();

      if (crop) scheduleOnRN(deliverCrop, crop);
      scheduleOnRN(deliverDetection, detection ? { ...detection, frameWidth, frameHeight } : null);
    },
    [captureCropSize, deliverCrop, deliverDetection],
  );

  const frameOutput = useFrameOutput({
    // Resolución alta: el detalle lunar está en los píxeles. Solo se recorta la zona de la Luna.
    targetResolution: CommonResolutions.FHD_4_3,
    pixelFormat: 'rgb',
    // Fotogramas ya derechos: así la foto final sale con la misma orientación que la vista previa.
    enablePhysicalBufferRotation: true,
    onFrame: handleFrame,
  });

  /** Captura `cropCount` recortes de lado `cropSize` centrados en la Luna (con el móvil quieto). */
  const captureCrops = useCallback(
    (cropCount: number, cropSize: number) => {
      capturedCrops.current = [];
      rejectedCropCount.current = 0;
      targetCropCount.current = cropCount;
      setCaptureProgress({ capturedCropCount: 0, targetCropCount: cropCount, rejectedCropCount: 0 });
      setCaptureCropSize(cropSize);
      captureTimeout.current = setTimeout(finishCapture, maximumCaptureMilliseconds);
      return new Promise<CaptureResult>((resolve) => {
        resolveCapture.current = resolve;
      });
    },
    [finishCapture],
  );

  /** Termina la captura en curso y entrega lo capturado hasta ahora. */
  const stopCapture = finishCapture;

  return {
    frameOutput,
    liveDetection,
    isCapturing: captureCropSize !== null,
    captureProgress,
    captureCrops,
    stopCapture,
  };
}

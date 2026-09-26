import { useCallback, useEffect, useRef, useState } from 'react';
import { CommonResolutions, type Frame, useFrameOutput } from 'react-native-vision-camera';
import { scheduleOnRN } from 'react-native-worklets';

import { readFramePixels } from '@/core/camera/framePixels';
import { type BrightObjectDetection, locateBrightObject } from '@/processing/image/lunarStacking';

import { copyGrayCropWithDownsampling, type LuckyFrameCropPlan } from './moonCapturePlanning';
import type { StarFrame } from './occultationAnalysis';

/** Detecciones por segundo que se envían al hilo JS. */
const maximumDetectionsPerSecond = 4;
/** Salto de píxeles al buscar la Luna: con fotogramas de 768×1024 va de sobra y es ligero. */
const detectionSampleStride = 2;
/** Cada cuántos fotogramas grabados se actualiza el contador en pantalla. */
const recordingProgressEveryFrames = 5;

export interface LiveMoonDetection extends BrightObjectDetection {
  frameWidth: number;
  frameHeight: number;
}

export interface FrameRecording {
  /** Luminancia de 8 bits, `outputSide`² por fotograma, recentrada en la Luna en cada uno. */
  grayFrames: Uint8Array[];
  outputSide: number;
  /** Desde el primer fotograma recibido hasta el último. */
  durationMilliseconds: number;
}

/**
 * Ocultación: recorte fijo alrededor de una estrella, que sigue a la Luna (la estrella y la Luna
 * derivan juntas por el cielo). Desplazamiento de la estrella respecto al centro de la Luna.
 */
export interface StarRecordingPlan {
  offsetFromMoonX: number;
  offsetFromMoonY: number;
  side: number;
}

interface ActiveStarRecording {
  starFrames: StarFrame[];
  maximumFrameCount: number;
  resolve: (starFrames: StarFrame[]) => void;
}

interface ActiveRecording {
  cropPlan: LuckyFrameCropPlan;
  targetFrameCount: number;
  grayFrames: Uint8Array[];
  firstFrameTime: number | null;
  lastFrameTime: number;
  resolve: (frameRecording: FrameRecording) => void;
}

/**
 * Localiza la Luna en los fotogramas de la vista previa (en el hilo de la cámara) y envía unas
 * pocas cifras (posición, tamaño, saturación) para apuntar, medir la luz y saber dónde recortar
 * las fotos de la ráfaga. Las fotos se toman aparte, a resolución completa.
 * `onDetection` recibe cada detección que llega al hilo JS (para ajustar la exposición).
 *
 * Para la imagen afortunada, `recordFrames` graba muchos fotogramas seguidos: en el hilo de la
 * cámara se recorta un cuadrado alrededor de la Luna (reducido si es grande) y solo ese recorte,
 * en luminancia, llega al hilo JS; el fotograma entero nunca se copia.
 */
export function useMoonFrames(onDetection?: (detection: LiveMoonDetection) => void) {
  const [liveDetection, setLiveDetection] = useState<LiveMoonDetection | null>(null);
  const [recordingCropPlan, setRecordingCropPlan] = useState<LuckyFrameCropPlan | null>(null);
  const [recordedFrameCount, setRecordedFrameCount] = useState(0);
  const activeRecordingRef = useRef<ActiveRecording | null>(null);
  const [starRecordingPlan, setStarRecordingPlan] = useState<StarRecordingPlan | null>(null);
  const activeStarRecordingRef = useRef<ActiveStarRecording | null>(null);
  const lastDetectionDeliveryTime = useRef(0);
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

  const finishStarRecording = useCallback(() => {
    const activeStarRecording = activeStarRecordingRef.current;
    if (!activeStarRecording) return;
    activeStarRecordingRef.current = null;
    setStarRecordingPlan(null);
    setRecordedFrameCount(0);
    activeStarRecording.resolve(activeStarRecording.starFrames);
  }, []);

  const deliverStarFrame = useCallback(
    (grayPixels: Uint8Array, side: number, sensorTimestampNanoseconds: number, wallClockMilliseconds: number) => {
      const activeStarRecording = activeStarRecordingRef.current;
      if (!activeStarRecording) return;
      activeStarRecording.starFrames.push({ grayPixels, side, sensorTimestampNanoseconds, wallClockMilliseconds });
      const recordedCount = activeStarRecording.starFrames.length;
      if (recordedCount % recordingProgressEveryFrames === 0) setRecordedFrameCount(recordedCount);
      if (recordedCount >= activeStarRecording.maximumFrameCount) finishStarRecording();
    },
    [finishStarRecording],
  );

  const finishRecording = useCallback(() => {
    finishStarRecording();
    const activeRecording = activeRecordingRef.current;
    if (!activeRecording) return;
    activeRecordingRef.current = null;
    setRecordingCropPlan(null);
    setRecordedFrameCount(0);
    activeRecording.resolve({
      grayFrames: activeRecording.grayFrames,
      outputSide: activeRecording.cropPlan.outputSide,
      durationMilliseconds:
        activeRecording.firstFrameTime === null ? 0 : activeRecording.lastFrameTime - activeRecording.firstFrameTime,
    });
  }, [finishStarRecording]);

  const deliverRecordedFrame = useCallback(
    (grayFrame: Uint8Array) => {
      const activeRecording = activeRecordingRef.current;
      // Pueden llegar fotogramas ya en camino después de terminar: se ignoran.
      if (!activeRecording || grayFrame.length !== activeRecording.cropPlan.outputSide ** 2) return;
      const currentTime = Date.now();
      activeRecording.firstFrameTime ??= currentTime;
      activeRecording.lastFrameTime = currentTime;
      activeRecording.grayFrames.push(grayFrame);
      const recordedCount = activeRecording.grayFrames.length;
      if (recordedCount % recordingProgressEveryFrames === 0) setRecordedFrameCount(recordedCount);
      if (recordedCount >= activeRecording.targetFrameCount) finishRecording();
    },
    [finishRecording],
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
      const frameWidth = framePixels.width;
      const frameHeight = framePixels.height;
      // La hora se anota al llegar el fotograma, en este hilo (sin esperar al hilo JS).
      const wallClockMilliseconds = Date.now();
      const detection = locateBrightObject(pixels, frameWidth, frameHeight, bytesPerRow, bytesPerPixel, detectionSampleStride);
      if (starRecordingPlan && detection) {
        const starCropPixels = copyGrayCropWithDownsampling(
          pixels,
          frameWidth,
          frameHeight,
          bytesPerRow,
          bytesPerPixel,
          Math.round(detection.centerX + starRecordingPlan.offsetFromMoonX - starRecordingPlan.side / 2),
          Math.round(detection.centerY + starRecordingPlan.offsetFromMoonY - starRecordingPlan.side / 2),
          1,
          starRecordingPlan.side,
        );
        scheduleOnRN(deliverStarFrame, starCropPixels, starRecordingPlan.side, frame.timestamp, wallClockMilliseconds);
      }
      if (recordingCropPlan && detection) {
        // Recorte centrado en la Luna de este fotograma; el apilado afina el alineado después.
        const grayFrame = copyGrayCropWithDownsampling(
          pixels,
          frameWidth,
          frameHeight,
          bytesPerRow,
          bytesPerPixel,
          Math.round(detection.centerX - recordingCropPlan.cropSide / 2),
          Math.round(detection.centerY - recordingCropPlan.cropSide / 2),
          recordingCropPlan.downsampleFactor,
          recordingCropPlan.outputSide,
        );
        scheduleOnRN(deliverRecordedFrame, grayFrame);
      }
      frame.dispose();
      scheduleOnRN(deliverDetection, detection ? { ...detection, frameWidth, frameHeight } : null);
    },
    [deliverDetection, deliverRecordedFrame, deliverStarFrame, recordingCropPlan, starRecordingPlan],
  );

  const frameOutput = useFrameOutput({
    // Resolución moderada: solo sirve para localizar la Luna. Así la salida de fotos (12 MP) cabe
    // con ella en la misma sesión de cámara en móviles de gama media.
    targetResolution: CommonResolutions.HD_4_3,
    pixelFormat: 'rgb',
    // Fotogramas ya derechos, como la vista previa y las fotos.
    enablePhysicalBufferRotation: true,
    onFrame: handleFrame,
  });

  /** Graba `targetFrameCount` recortes (o los que haya al llamar a `stopRecording`). */
  const recordFrames = useCallback((cropPlan: LuckyFrameCropPlan, targetFrameCount: number) => {
    if (activeRecordingRef.current || activeStarRecordingRef.current) return Promise.reject(new Error('Ya hay una grabación en marcha'));
    return new Promise<FrameRecording>((resolve) => {
      activeRecordingRef.current = {
        cropPlan,
        targetFrameCount,
        grayFrames: [],
        firstFrameTime: null,
        lastFrameTime: 0,
        resolve,
      };
      setRecordedFrameCount(0);
      setRecordingCropPlan(cropPlan);
    });
  }, []);

  /** Graba recortes alrededor de una estrella hasta `maximumFrameCount` o hasta `stopRecording`. */
  const recordStarFrames = useCallback((plan: StarRecordingPlan, maximumFrameCount: number) => {
    if (activeRecordingRef.current || activeStarRecordingRef.current) return Promise.reject(new Error('Ya hay una grabación en marcha'));
    return new Promise<StarFrame[]>((resolve) => {
      activeStarRecordingRef.current = { starFrames: [], maximumFrameCount, resolve };
      setRecordedFrameCount(0);
      setStarRecordingPlan(plan);
    });
  }, []);

  // Al salir de la pantalla, se termina la grabación (con lo que haya) para no dejar la promesa colgada.
  useEffect(() => finishRecording, [finishRecording]);

  return {
    frameOutput,
    liveDetection,
    recordFrames,
    recordStarFrames,
    stopRecording: finishRecording,
    isRecording: recordingCropPlan !== null || starRecordingPlan !== null,
    recordedFrameCount,
  };
}

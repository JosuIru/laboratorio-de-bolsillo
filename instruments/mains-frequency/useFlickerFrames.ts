import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { CommonResolutions, type Frame, useFrameOutput } from 'react-native-vision-camera';
import { scheduleOnRN } from 'react-native-worklets';

import { readFramePixels } from '@/core/camera/framePixels';
import { createSrgbToLinearTable } from '@/processing/color/regionSampling';
import { createFlickerAnalyzer, type FlickerAnalysis } from '@/processing/flicker/flickerAnalyzer';
import { computeLuminanceProfiles, sampledProfileLength } from '@/processing/flicker/luminanceProfiles';

/** Cada cuánto se analiza lo acumulado (el análisis ocupa el hilo JS unas decenas de ms). */
const analysisIntervalMilliseconds = 750;
/** Muestras aproximadas del perfil en el eje corto: de sobra para 1-5 bandas por fotograma. */
const targetShortAxisSamples = 240;

interface DeliveredProfiles {
  cameraTimestamp: number;
  rowProfile: Float64Array;
  columnProfile: Float64Array;
  saturatedFraction: number;
  meanLuminance: number;
}

/**
 * vision-camera da la marca de tiempo del fotograma en nanosegundos en Android (la del sensor,
 * `SENSOR_TIMESTAMP`, inicio de la exposición) y en segundos en iOS.
 */
function cameraTimestampToSeconds(cameraTimestamp: number): number {
  return Platform.OS === 'ios' ? cameraTimestamp : cameraTimestamp / 1e9;
}

/**
 * Perfiles de luminancia de cada fotograma (en el hilo de la cámara) y análisis periódico del
 * parpadeo (en el hilo JS). Los fotogramas se procesan en la orientación nativa del sensor, sin
 * girarlos: así las filas del búfer son las filas que lee el obturador rodante.
 */
export function useFlickerFrames(nominalFlickerFrequencyHz: number, isActive: boolean) {
  const [srgbToLinearTable] = useState(createSrgbToLinearTable);
  const [analysis, setAnalysis] = useState<FlickerAnalysis | null>(null);
  const [meanLuminance, setMeanLuminance] = useState<number | null>(null);
  // Otra frecuencia nominal: otro analizador, que empieza de cero.
  const flickerAnalyzer = useMemo(
    () => createFlickerAnalyzer({ nominalFlickerFrequencyHz }),
    [nominalFlickerFrequencyHz],
  );
  const lastLuminanceUpdateTime = useRef(0);
  // El análisis del analizador anterior no vale para la nueva frecuencia nominal.
  const [analyzedByAnalyzer, setAnalyzedByAnalyzer] = useState(flickerAnalyzer);
  if (analyzedByAnalyzer !== flickerAnalyzer) {
    setAnalyzedByAnalyzer(flickerAnalyzer);
    setAnalysis(null);
  }

  useEffect(() => {
    if (!isActive) return;
    const analysisTimer = setInterval(() => {
      setAnalysis(flickerAnalyzer.analyze());
    }, analysisIntervalMilliseconds);
    return () => clearInterval(analysisTimer);
  }, [isActive, flickerAnalyzer]);

  const deliverProfiles = useCallback((deliveredProfiles: DeliveredProfiles) => {
    if (!(deliveredProfiles.cameraTimestamp > 0)) return;
    flickerAnalyzer.pushFrame({
      timestampSeconds: cameraTimestampToSeconds(deliveredProfiles.cameraTimestamp),
      rowProfile: deliveredProfiles.rowProfile,
      columnProfile: deliveredProfiles.columnProfile,
      saturatedFraction: deliveredProfiles.saturatedFraction,
    });
    const currentTime = Date.now();
    if (currentTime - lastLuminanceUpdateTime.current > 1000) {
      lastLuminanceUpdateTime.current = currentTime;
      setMeanLuminance(deliveredProfiles.meanLuminance);
    }
  }, [flickerAnalyzer]);

  const handleFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      const cameraTimestamp = frame.timestamp;
      const framePixels = readFramePixels(frame);
      if (!framePixels) {
        frame.dispose();
        return;
      }
      const { pixels, width: frameWidth, height: frameHeight, bytesPerRow, bytesPerPixel } = framePixels;
      const sampleStride = Math.max(1, Math.round(Math.min(frameWidth, frameHeight) / targetShortAxisSamples));
      const rowProfile = new Float64Array(sampledProfileLength(frameHeight, sampleStride));
      const columnProfile = new Float64Array(sampledProfileLength(frameWidth, sampleStride));
      const profileResult = computeLuminanceProfiles(
        pixels,
        frameWidth,
        frameHeight,
        bytesPerRow,
        bytesPerPixel,
        srgbToLinearTable,
        sampleStride,
        rowProfile,
        columnProfile,
      );
      frame.dispose();
      scheduleOnRN(deliverProfiles, {
        cameraTimestamp,
        rowProfile,
        columnProfile,
        saturatedFraction: profileResult.saturatedFraction,
        meanLuminance: profileResult.meanLuminance,
      });
    },
    [srgbToLinearTable, deliverProfiles],
  );

  const frameOutput = useFrameOutput({
    // Resolución baja: basta para unas pocas bandas y el recorrido por píxel es mucho más ligero.
    targetResolution: CommonResolutions.VGA_4_3,
    pixelFormat: 'rgb',
    // Sin girar: las filas del búfer deben ser las del sensor.
    enablePhysicalBufferRotation: false,
    onFrame: handleFrame,
  });

  const resetAnalysis = useCallback(() => {
    flickerAnalyzer.reset();
    setAnalysis(null);
  }, [flickerAnalyzer]);

  return { frameOutput, analysis, meanLuminance, resetAnalysis };
}

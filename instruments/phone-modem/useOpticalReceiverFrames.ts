import { useCallback, useEffect, useRef, useState } from 'react';
import { CommonResolutions, type Frame, useFrameOutput } from 'react-native-vision-camera';
import { scheduleOnRN } from 'react-native-worklets';

import { readFramePixels } from '@/core/camera/framePixels';
import type { ErrorCorrection } from '@/processing/modem/frameCodec';
import {
  type BlinkingTileSelector,
  createBlinkingTileSelector,
  createFrameTimestampConverter,
  measureTileLuminances,
} from '@/processing/modem/lightSampling';
import {
  createOpticalReceiver,
  opticalConfigurationFor,
  type OpticalReceiver,
  type OpticalReceiverEvent,
  type OpticalReceiverStatus,
  type OpticalSpeedPreset,
} from '@/processing/modem/opticalModem';

/** Rejilla de casillas sobre el centro de la imagen; se lee la que más parpadea. */
export const tileGridSize = 5;
/** Fracción central del fotograma que cubre la rejilla. */
export const tileCoveredFraction = 0.6;
const tilePixelStep = 4;
const statusUpdateMilliseconds = 120;
/** Muestras de brillo que se dibujan en la traza. */
export const luminanceTraceLength = 90;

export interface OpticalReceiverSnapshot {
  receiverStatus: OpticalReceiverStatus;
  /** Brillo (0-255) de la casilla elegida en los últimos fotogramas, del más viejo al más nuevo. */
  luminanceTrace: number[];
  /** Fotogramas por segundo medidos. */
  framesPerSecond: number;
}

interface ReceiverSession {
  opticalReceiver: OpticalReceiver;
  tileSelector: BlinkingTileSelector;
  convertTimestamp: (rawTimestamp: number) => number | null;
  luminanceTrace: number[];
  frameTimes: number[];
}

interface OpticalReceiverFramesOptions {
  isReceiving: boolean;
  speedPreset: OpticalSpeedPreset;
  errorCorrection: ErrorCorrection;
  onReceiverEvent(receiverEvent: OpticalReceiverEvent): void;
}

/**
 * Receptor por la cámara: en el hilo de la cámara (worklet) mide el brillo medio de cada casilla
 * de la rejilla y envía esos pocos números al hilo JS, que elige la casilla que parpadea y se la
 * pasa al receptor óptico.
 */
export function useOpticalReceiverFrames({
  isReceiving,
  speedPreset,
  errorCorrection,
  onReceiverEvent,
}: OpticalReceiverFramesOptions) {
  const [snapshot, setSnapshot] = useState<OpticalReceiverSnapshot | null>(null);
  const sessionRef = useRef<ReceiverSession | null>(null);
  const lastStatusUpdateRef = useRef(0);
  const onReceiverEventRef = useRef(onReceiverEvent);
  useEffect(() => {
    onReceiverEventRef.current = onReceiverEvent;
  }, [onReceiverEvent]);

  useEffect(() => {
    if (!isReceiving) {
      sessionRef.current = null;
      return;
    }
    sessionRef.current = {
      opticalReceiver: createOpticalReceiver({ configuration: opticalConfigurationFor(speedPreset), errorCorrection }),
      tileSelector: createBlinkingTileSelector(tileGridSize * tileGridSize),
      convertTimestamp: createFrameTimestampConverter(),
      luminanceTrace: [],
      frameTimes: [],
    };
    return () => {
      sessionRef.current = null;
      setSnapshot(null);
    };
  }, [isReceiving, speedPreset, errorCorrection]);

  const deliverTileLuminances = useCallback((rawTimestamp: number, tileLuminances: number[]) => {
    const session = sessionRef.current;
    if (!session) return;
    const timestampSeconds = session.convertTimestamp(rawTimestamp);
    if (timestampSeconds === null) return;
    const isSelectionLocked = session.opticalReceiver.status.phase === 'receiving';
    const { luminance } = session.tileSelector.push(tileLuminances, isSelectionLocked);
    const receiverEvents = session.opticalReceiver.pushSample(timestampSeconds, luminance);
    for (const receiverEvent of receiverEvents) onReceiverEventRef.current(receiverEvent);

    session.luminanceTrace.push(luminance);
    if (session.luminanceTrace.length > luminanceTraceLength) session.luminanceTrace.shift();
    session.frameTimes.push(timestampSeconds);
    if (session.frameTimes.length > 30) session.frameTimes.shift();

    const currentMilliseconds = Date.now();
    if (currentMilliseconds - lastStatusUpdateRef.current < statusUpdateMilliseconds) return;
    lastStatusUpdateRef.current = currentMilliseconds;
    const frameSpanSeconds = session.frameTimes[session.frameTimes.length - 1]! - session.frameTimes[0]!;
    setSnapshot({
      receiverStatus: session.opticalReceiver.status,
      luminanceTrace: [...session.luminanceTrace],
      framesPerSecond: frameSpanSeconds > 0 ? (session.frameTimes.length - 1) / frameSpanSeconds : 0,
    });
  }, []);

  const handleFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      const framePixels = readFramePixels(frame);
      if (!framePixels) {
        frame.dispose();
        return;
      }
      const tileLuminances = measureTileLuminances(
        framePixels.pixels,
        framePixels.width,
        framePixels.height,
        framePixels.bytesPerRow,
        framePixels.pixelLayout,
        tileGridSize,
        tileCoveredFraction,
        tilePixelStep,
      );
      const frameTimestamp = frame.timestamp;
      frame.dispose();
      scheduleOnRN(deliverTileLuminances, frameTimestamp, tileLuminances);
    },
    [deliverTileLuminances],
  );

  const frameOutput = useFrameOutput({
    // Resolución baja: solo se promedian casillas grandes.
    targetResolution: CommonResolutions.VGA_4_3,
    pixelFormat: 'rgb',
    onFrame: handleFrame,
  });

  return { frameOutput, snapshot };
}

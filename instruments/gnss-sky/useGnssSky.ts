import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { useIsAppActive } from '@/core/useIsAppActive';
import { InterferenceDetector, type InterferenceAssessment } from '@/processing/gnss/interferenceDetector';
import {
  type RawMeasurementsSummary,
  summarizeRawMeasurements,
  toAutomaticGainControlReadings,
  toSatelliteObservations,
} from '@/processing/gnss/rawConversion';
import { summarizeSky, type SkySummary } from '@/processing/gnss/skyStatistics';
import type { AutomaticGainControlReading, SatelliteObservation } from '@/processing/gnss/types';

import {
  type GnssRawCapabilities,
  type GnssRawMeasurementsStatus,
  gnssRawModule,
} from '../../modules/gnss-raw';

/** Segundos de historia en las gráficas (una muestra por época, ~1 Hz). */
export const historyLengthSeconds = 120;
/** El AGC llega con las medidas crudas; se considera vigente durante este tiempo (s). */
const automaticGainControlValiditySeconds = 3;

export type GnssSupport =
  | { status: 'unsupported-platform' }
  | { status: 'module-missing' }
  | { status: 'no-hardware' }
  | { status: 'needs-fine-location'; canAskAgain: boolean }
  | { status: 'location-off' }
  | { status: 'ready'; capabilities: GnssRawCapabilities };

export interface GnssSkySnapshot {
  observations: SatelliteObservation[];
  skySummary: SkySummary;
  assessment: InterferenceAssessment | null;
  rawMeasurementsSummary: RawMeasurementsSummary | null;
  automaticGainControlReadings: AutomaticGainControlReading[];
  rawMeasurementsStatus: GnssRawMeasurementsStatus | null;
  timeToFirstFixSeconds: number | null;
  horizontalAccuracyMeters: number | null;
  /** Media de las 4 señales más fuertes, una por época (dB-Hz). */
  topFourHistory: number[];
  /** AGC medio de las bandas con dato, una muestra por época (dB). Vacío si el chip no lo da. */
  automaticGainControlHistory: number[];
  epochCount: number;
}

const emptySnapshot: GnssSkySnapshot = {
  observations: [],
  skySummary: summarizeSky([]),
  assessment: null,
  rawMeasurementsSummary: null,
  automaticGainControlReadings: [],
  rawMeasurementsStatus: null,
  timeToFirstFixSeconds: null,
  horizontalAccuracyMeters: null,
  topFourHistory: [],
  automaticGainControlHistory: [],
  epochCount: 0,
};

function appendToHistory(history: readonly number[], newValue: number): number[] {
  const updatedHistory = [...history, newValue];
  return updatedHistory.length > historyLengthSeconds ? updatedHistory.slice(-historyLengthSeconds) : updatedHistory;
}

function readSupport(): GnssSupport {
  if (Platform.OS !== 'android') return { status: 'unsupported-platform' };
  if (!gnssRawModule) return { status: 'module-missing' };
  let capabilities: GnssRawCapabilities;
  try {
    capabilities = gnssRawModule.getCapabilities();
  } catch {
    return { status: 'module-missing' };
  }
  if (!capabilities.hasGnssHardware) return { status: 'no-hardware' };
  if (!capabilities.isLocationEnabled) return { status: 'location-off' };
  if (!capabilities.hasFineLocationPermission) return { status: 'needs-fine-location', canAskAgain: true };
  return { status: 'ready', capabilities };
}

/**
 * Escucha el receptor GNSS mientras la pantalla está abierta y la app en primer plano. Si se
 * sale, para el GNSS (gasta batería) y al volver empieza de cero (el detector vuelve a aprender).
 */
export function useGnssSky() {
  const isAppActive = useIsAppActive();
  const [support, setSupport] = useState<GnssSupport>(readSupport);
  const [snapshot, setSnapshot] = useState<GnssSkySnapshot>(emptySnapshot);
  const [startErrorMessage, setStartErrorMessage] = useState<string | null>(null);
  const interferenceDetectorRef = useRef(new InterferenceDetector());

  // Ajuste de estado durante el render (patrón recomendado por React): al volver a primer plano
  // se revisan permisos y ubicación (pueden haber cambiado en los ajustes); al salir, se empieza
  // de cero.
  const [wasAppActive, setWasAppActive] = useState(isAppActive);
  if (wasAppActive !== isAppActive) {
    setWasAppActive(isAppActive);
    if (isAppActive) {
      setSupport(readSupport());
    } else {
      setSnapshot(emptySnapshot);
      setStartErrorMessage(null);
    }
  }

  const refreshSupport = useCallback(() => setSupport(readSupport()), []);

  const requestFineLocation = useCallback(async () => {
    // expo-location pide ubicación precisa y aproximada a la vez; el usuario puede quedarse con la
    // aproximada, que no basta para ver los satélites.
    const permissionResponse = await Location.requestForegroundPermissionsAsync();
    refreshSupport();
    if (permissionResponse.android?.accuracy !== 'fine') {
      setSupport({ status: 'needs-fine-location', canAskAgain: permissionResponse.canAskAgain });
    }
  }, [refreshSupport]);

  const isReady = support.status === 'ready';

  useEffect(() => {
    if (!isReady || !isAppActive || !gnssRawModule) return;
    const nativeModule = gnssRawModule;
    const interferenceDetector = interferenceDetectorRef.current;
    interferenceDetector.reset();

    let latestAutomaticGainControl: { readings: AutomaticGainControlReading[]; receivedAtSeconds: number } | null = null;

    const subscriptions = [
      nativeModule.addListener('onSatelliteStatus', (statusEvent) => {
        const observations = toSatelliteObservations(statusEvent.satellites);
        const timestampSeconds = statusEvent.elapsedRealtimeSeconds;
        const currentAutomaticGainControlReadings =
          latestAutomaticGainControl &&
          timestampSeconds - latestAutomaticGainControl.receivedAtSeconds <= automaticGainControlValiditySeconds
            ? latestAutomaticGainControl.readings
            : [];
        const assessment = interferenceDetector.update({
          timestampSeconds,
          observations,
          automaticGainControlReadings: currentAutomaticGainControlReadings,
        });
        const skySummary = summarizeSky(observations);
        setSnapshot((previousSnapshot) => ({
          ...previousSnapshot,
          observations,
          skySummary,
          assessment,
          automaticGainControlReadings: currentAutomaticGainControlReadings,
          topFourHistory: appendToHistory(previousSnapshot.topFourHistory, skySummary.topFourMeanCarrierToNoiseDbHz ?? 0),
          automaticGainControlHistory:
            currentAutomaticGainControlReadings.length > 0
              ? appendToHistory(
                  previousSnapshot.automaticGainControlHistory,
                  currentAutomaticGainControlReadings.reduce((sum, reading) => sum + reading.levelDb, 0) /
                    currentAutomaticGainControlReadings.length,
                )
              : previousSnapshot.automaticGainControlHistory,
          epochCount: previousSnapshot.epochCount + 1,
        }));
      }),
      nativeModule.addListener('onRawMeasurements', (measurementsEvent) => {
        const readings = toAutomaticGainControlReadings(measurementsEvent);
        if (readings.length > 0) {
          latestAutomaticGainControl = { readings, receivedAtSeconds: measurementsEvent.elapsedRealtimeSeconds };
        }
        const rawMeasurementsSummary = summarizeRawMeasurements(measurementsEvent);
        setSnapshot((previousSnapshot) => ({
          ...previousSnapshot,
          rawMeasurementsSummary,
          // Si llegan medidas, el chip las soporta aunque no haya llegado el estado.
          rawMeasurementsStatus: previousSnapshot.rawMeasurementsStatus ?? 'ready',
        }));
      }),
      nativeModule.addListener('onRawMeasurementsStatus', ({ status }) => {
        setSnapshot((previousSnapshot) => ({ ...previousSnapshot, rawMeasurementsStatus: status }));
      }),
      nativeModule.addListener('onEngineState', (engineEvent) => {
        if (engineEvent.state !== 'firstFix' || engineEvent.timeToFirstFixMilliseconds === undefined) return;
        const timeToFirstFixSeconds = engineEvent.timeToFirstFixMilliseconds / 1000;
        setSnapshot((previousSnapshot) => ({ ...previousSnapshot, timeToFirstFixSeconds }));
      }),
      nativeModule.addListener('onLocationFix', (fixEvent) => {
        setSnapshot((previousSnapshot) => ({
          ...previousSnapshot,
          horizontalAccuracyMeters: fixEvent.horizontalAccuracyMeters,
        }));
      }),
    ];

    try {
      nativeModule.start();
    } catch (startError) {
      const startErrorText = startError instanceof Error ? startError.message : String(startError);
      // Se notifica fuera del cuerpo del efecto, como cualquier otro evento del receptor.
      queueMicrotask(() => setStartErrorMessage(startErrorText));
    }

    return () => {
      for (const subscription of subscriptions) subscription.remove();
      nativeModule.stop();
    };
  }, [isReady, isAppActive]);

  return { support, snapshot, startErrorMessage, requestFineLocation, refreshSupport };
}

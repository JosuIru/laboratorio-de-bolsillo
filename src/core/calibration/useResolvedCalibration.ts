import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import type { AnyInstrumentDefinition } from '@/core/instruments/types';

import { type ResolvedCalibration, resolveActiveCalibration } from './calibrationService';

type CalibrationLoadState =
  | { status: 'loading' }
  | { status: 'ready'; resolvedCalibration: ResolvedCalibration }
  | { status: 'error'; errorMessage: string };

/** Carga la calibración activa cada vez que la pantalla gana el foco (p. ej. al volver de calibrar). */
export function useResolvedCalibration(instrument: AnyInstrumentDefinition | undefined): CalibrationLoadState {
  const [loadState, setLoadState] = useState<CalibrationLoadState>({ status: 'loading' });

  useFocusEffect(
    useCallback(() => {
      if (!instrument) return;
      let isCurrentLoad = true;
      resolveActiveCalibration(instrument)
        .then((resolvedCalibration) => {
          if (isCurrentLoad) setLoadState({ status: 'ready', resolvedCalibration });
        })
        .catch((loadError: unknown) => {
          if (isCurrentLoad) setLoadState({ status: 'error', errorMessage: String(loadError) });
        });
      return () => {
        isCurrentLoad = false;
      };
    }, [instrument]),
  );

  return loadState;
}

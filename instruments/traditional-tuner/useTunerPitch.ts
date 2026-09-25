import { useState } from 'react';

import { useMicrophoneSpectrum } from '@/core/audio/useMicrophoneSpectrum';
import { estimatePitchMcLeod } from '@/processing/dsp/mcleodPitch';

import { createPitchStabilizer, minimumPitchClarity } from './tuningSystems';

/**
 * 4096 muestras (≈ 85 ms a 48 kHz): caben dos periodos de la nota más grave (≈ 40 Hz) y la
 * respuesta sigue siendo rápida. Solo se usa la forma de onda, no el espectro.
 */
const tunerWindowSize = 4096;
const readingIntervalMilliseconds = 80;
/** Del Mi1 de un contrabajo a los agudos de un txistu o una gaita. */
export const minimumTunerFrequencyHz = 40;
export const maximumTunerFrequencyHz = 2500;

export interface TunerPitchReading {
  /** Frecuencia estable (mediana de las últimas lecturas), o null si no suena nada claro. */
  stableFrequencyHz: number | null;
  latestClarity: number | null;
}

export function useTunerPitch({ isActive }: { isActive: boolean }) {
  const [pitchStabilizer] = useState(() => createPitchStabilizer());
  const [pitchReading, setPitchReading] = useState<TunerPitchReading>({ stableFrequencyHz: null, latestClarity: null });

  const microphoneStatus = useMicrophoneSpectrum({
    isActive,
    fftSize: tunerWindowSize,
    frameIntervalMilliseconds: readingIntervalMilliseconds,
    onFrame: ({ timeDomainSamples, sampleRateHz }) => {
      const pitchEstimate = estimatePitchMcLeod(timeDomainSamples, {
        sampleRateHz,
        minimumFrequencyHz: minimumTunerFrequencyHz,
        maximumFrequencyHz: Math.min(maximumTunerFrequencyHz, sampleRateHz / 4),
      });
      const isEstimateClear = pitchEstimate !== null && pitchEstimate.clarity >= minimumPitchClarity;
      setPitchReading({
        stableFrequencyHz: pitchStabilizer.push(isEstimateClear ? pitchEstimate.frequencyHz : null),
        latestClarity: pitchEstimate?.clarity ?? null,
      });
    },
  });

  return { microphoneStatus, pitchReading };
}

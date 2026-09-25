import { createSeededRandom } from '@/processing/dsp/signalGenerator';

import { createChirpLocator, locateChirp } from './chirpArrival';
import { locateClapOnset, pickOnsetByAkaikeCriterion } from './clapOnset';
import { generateReferenceChirp, generateReferenceSequence, referenceChirpSeparationSeconds } from './referenceSignal';
import { createSyntheticClap, synthesizeRecording } from './syntheticRecordings';

const sampleRateHz = 48000;
const syntheticClap = createSyntheticClap(7);

function recordingWith(options: {
  chirpArrivals?: { arrivalSeconds: number; amplitude: number }[];
  clapArrivals?: { arrivalSeconds: number; amplitude: number }[];
  noiseAmplitude?: number;
  durationSeconds?: number;
  seed?: number;
}) {
  return synthesizeRecording({
    sampleRateHz,
    durationSeconds: options.durationSeconds ?? 1,
    recordingStartSeconds: 0,
    clockDriftPartsPerMillion: 0,
    chirpArrivals: options.chirpArrivals ?? [],
    clapArrivals: options.clapArrivals ?? [],
    syntheticClap,
    noiseAmplitude: options.noiseAmplitude ?? 0.01,
    seed: options.seed ?? 1,
  });
}

describe('señal de referencia', () => {
  it('pone el segundo chirrido exactamente a la separación fijada', () => {
    const referenceSequence = generateReferenceSequence(sampleRateHz);
    const chirpSamples = generateReferenceChirp(sampleRateHz);
    const separationSamples = referenceChirpSeparationSeconds * sampleRateHz;
    expect(Array.from(referenceSequence.subarray(separationSamples, separationSamples + 50))).toEqual(
      Array.from(chirpSamples.subarray(0, 50)),
    );
    expect(referenceSequence.length).toBeGreaterThan(separationSamples + chirpSamples.length);
  });
});

describe('llegada del chirrido', () => {
  const chirpLocator = createChirpLocator({
    sampleRateHz,
    chirpSamples: generateReferenceChirp(sampleRateHz),
    maximumSegmentLength: 20000,
  });

  it('encuentra el comienzo con precisión de centésimas de muestra', () => {
    const arrivalSeconds = 0.2 + 0.37 / sampleRateHz;
    const recording = recordingWith({ chirpArrivals: [{ arrivalSeconds, amplitude: 0.2 }], noiseAmplitude: 0.02 });
    const chirpArrival = locateChirp(chirpLocator, recording, 8000, 14000);
    expect(chirpArrival).not.toBeNull();
    expect(Math.abs(chirpArrival!.arrivalSampleIndex - arrivalSeconds * sampleRateHz)).toBeLessThan(0.05);
    expect(chirpArrival!.amplitude).toBeGreaterThan(0.15);
  });

  it('se queda con el camino directo aunque un rebote llegue más fuerte', () => {
    const arrivalSeconds = 0.2;
    const recording = recordingWith({
      chirpArrivals: [
        { arrivalSeconds, amplitude: 0.1 },
        { arrivalSeconds: arrivalSeconds + 0.004, amplitude: 0.16 },
      ],
    });
    const chirpArrival = locateChirp(chirpLocator, recording, 8000, 14000);
    expect(chirpArrival).not.toBeNull();
    expect(Math.abs(chirpArrival!.arrivalSampleIndex - arrivalSeconds * sampleRateHz)).toBeLessThan(0.5);
  });

  it('no confunde una palmada con el chirrido', () => {
    const recording = recordingWith({ clapArrivals: [{ arrivalSeconds: 0.2, amplitude: 0.8 }] });
    expect(locateChirp(chirpLocator, recording, 8000, 14000)).toBeNull();
  });

  it('no detecta nada en el ruido', () => {
    const recording = recordingWith({ noiseAmplitude: 0.05 });
    expect(locateChirp(chirpLocator, recording, 2000, 30000)).toBeNull();
  });

  it('lo detecta incluso por debajo del ruido', () => {
    const arrivalSeconds = 0.3;
    const recording = recordingWith({ chirpArrivals: [{ arrivalSeconds, amplitude: 0.02 }], noiseAmplitude: 0.05 });
    const chirpArrival = locateChirp(chirpLocator, recording, 12000, 18000);
    expect(chirpArrival).not.toBeNull();
    expect(Math.abs(chirpArrival!.arrivalSampleIndex - arrivalSeconds * sampleRateHz)).toBeLessThan(0.5);
  });
});

describe('selector AIC', () => {
  it('encuentra el cambio de varianza de ruido a señal', () => {
    const nextRandom = createSeededRandom(3);
    const values = Array.from({ length: 600 }, (_, sampleIndex) => (nextRandom() - 0.5) * (sampleIndex >= 400 ? 1 : 0.02));
    const onsetPosition = pickOnsetByAkaikeCriterion(values, 0, values.length);
    expect(onsetPosition).not.toBeNull();
    expect(Math.abs(onsetPosition! - 400)).toBeLessThan(1.5);
  });
});

describe('comienzo de la palmada', () => {
  it('lo sitúa con error menor que una muestra', () => {
    for (const fractionalSamples of [0, 0.25, 0.5, 0.8]) {
      const arrivalSeconds = 0.5 + (123 + fractionalSamples) / sampleRateHz;
      const recording = recordingWith({
        clapArrivals: [{ arrivalSeconds, amplitude: 0.3 }],
        noiseAmplitude: 0.003,
        seed: 11,
      });
      const clapOnset = locateClapOnset(recording, 10000, 40000, sampleRateHz);
      expect(clapOnset).not.toBeNull();
      expect(Math.abs(clapOnset!.onsetSampleIndex - arrivalSeconds * sampleRateHz)).toBeLessThan(1);
      expect(clapOnset!.hasCompetingOnset).toBe(false);
    }
  });

  it('no lo retrasa cuando la palmada llega débil (móvil lejano)', () => {
    const arrivalSeconds = 0.5;
    const onsetFor = (clapAmplitude: number) =>
      locateClapOnset(
        recordingWith({ clapArrivals: [{ arrivalSeconds, amplitude: clapAmplitude }], noiseAmplitude: 0.002, seed: 5 }),
        10000,
        40000,
        sampleRateHz,
      )!.onsetSampleIndex;
    expect(Math.abs(onsetFor(0.6) - onsetFor(0.06))).toBeLessThan(1.5);
  });

  it('prefiere el sonido directo al rebote y avisa de un segundo golpe', () => {
    const arrivalSeconds = 0.4;
    const recording = recordingWith({
      clapArrivals: [
        { arrivalSeconds, amplitude: 0.2 },
        { arrivalSeconds: arrivalSeconds + 0.005, amplitude: 0.25 },
        { arrivalSeconds: 0.7, amplitude: 0.2 },
      ],
      noiseAmplitude: 0.003,
    });
    const clapOnset = locateClapOnset(recording, 10000, 40000, sampleRateHz);
    expect(clapOnset).not.toBeNull();
    expect(Math.abs(clapOnset!.onsetSampleIndex - arrivalSeconds * sampleRateHz)).toBeLessThan(2);
    expect(clapOnset!.hasCompetingOnset).toBe(true);
  });

  it('no inventa palmadas en el ruido', () => {
    expect(locateClapOnset(recordingWith({ noiseAmplitude: 0.02 }), 10000, 40000, sampleRateHz)).toBeNull();
  });
});

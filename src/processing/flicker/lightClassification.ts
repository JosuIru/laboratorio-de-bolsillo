/**
 * Métricas del parpadeo (porcentaje de parpadeo, índice de parpadeo, distorsión armónica) a
 * partir de los armónicos ajustados, y una clasificación orientativa del tipo de luz.
 *
 * Ojo: la cámara integra la luz durante el tiempo de exposición, lo que suaviza la onda. Las
 * profundidades medidas son un mínimo: la real es igual o mayor (mucho mayor si la exposición se
 * acerca a un periodo del parpadeo, 10 ms a 100 Hz).
 */

export interface FlickerMetrics {
  /** (máx − mín) / (máx + mín) de la onda reconstruida, en % (0-100). */
  percentFlicker: number;
  /** Índice de parpadeo (IES): área sobre la media / área total, de 0 a 1. */
  flickerIndex: number;
  /** √(Σ armónicos²≥2) / fundamental: 0 para una senoidal pura. */
  harmonicDistortion: number;
  /** Amplitud de la fundamental relativa a la media (0,1 = 10 %). */
  fundamentalDepth: number;
}

const waveformSampleCount = 360;

/** Reconstruye un periodo de la onda (media 1) con los armónicos y calcula las métricas. */
export function computeFlickerMetrics(relativeAmplitudes: readonly number[], phases: readonly number[]): FlickerMetrics {
  let maximumValue = Number.NEGATIVE_INFINITY;
  let minimumValue = Number.POSITIVE_INFINITY;
  let areaAboveMean = 0;
  for (let sampleIndex = 0; sampleIndex < waveformSampleCount; sampleIndex++) {
    const cyclePhase = (2 * Math.PI * sampleIndex) / waveformSampleCount;
    let waveformValue = 1;
    for (let harmonicIndex = 0; harmonicIndex < relativeAmplitudes.length; harmonicIndex++) {
      waveformValue +=
        relativeAmplitudes[harmonicIndex]! * Math.cos((harmonicIndex + 1) * cyclePhase + (phases[harmonicIndex] ?? 0));
    }
    // La luz no puede ser negativa: un ajuste con mucha modulación se recorta en 0.
    waveformValue = Math.max(0, waveformValue);
    maximumValue = Math.max(maximumValue, waveformValue);
    minimumValue = Math.min(minimumValue, waveformValue);
    areaAboveMean += Math.max(0, waveformValue - 1);
  }
  const fundamentalDepth = relativeAmplitudes[0] ?? 0;
  let higherHarmonicPower = 0;
  for (let harmonicIndex = 1; harmonicIndex < relativeAmplitudes.length; harmonicIndex++) {
    higherHarmonicPower += relativeAmplitudes[harmonicIndex]! ** 2;
  }
  return {
    percentFlicker: maximumValue + minimumValue > 0 ? (100 * (maximumValue - minimumValue)) / (maximumValue + minimumValue) : 0,
    flickerIndex: areaAboveMean / waveformSampleCount,
    harmonicDistortion: fundamentalDepth > 0 ? Math.sqrt(higherHarmonicPower) / fundamentalDepth : 0,
    fundamentalDepth,
  };
}

export type LightType = 'steady' | 'incandescent' | 'fluorescent' | 'flickeringLed';

/** Por debajo de este porcentaje de parpadeo se considera luz estable. */
export const steadyPercentFlickerLimit = 2;
/** Onda casi senoidal por debajo de esta distorsión armónica. */
const sinusoidalHarmonicDistortionLimit = 0.3;
const incandescentPercentFlickerLimit = 20;
const fluorescentPercentFlickerLimit = 60;

/**
 * Clasificación orientativa. Se basa en la profundidad y en la forma de la onda:
 * - incandescente y halógena: parpadeo suave y senoidal (el filamento tiene inercia térmica);
 * - fluorescente con reactancia magnética: senoidal y más profundo;
 * - LED con parpadeo: muy profundo o con forma no senoidal (driver sencillo, regulador);
 * - estable: LED con buen driver, fluorescente electrónico o luz de día.
 * `null` en las métricas = no se han detectado bandas.
 */
export function classifyLight(metrics: FlickerMetrics | null): LightType {
  if (!metrics || metrics.percentFlicker < steadyPercentFlickerLimit) return 'steady';
  const isSinusoidal = metrics.harmonicDistortion < sinusoidalHarmonicDistortionLimit;
  if (!isSinusoidal || metrics.percentFlicker >= fluorescentPercentFlickerLimit) return 'flickeringLed';
  return metrics.percentFlicker < incandescentPercentFlickerLimit ? 'incandescent' : 'fluorescent';
}

export type FlickerRiskLevel = 'noObservableEffect' | 'lowRisk' | 'aboveLowRisk';

/**
 * Nivel según la recomendación IEEE 1789-2015 (porcentaje de parpadeo frente a frecuencia):
 * por encima de 90 Hz, riesgo bajo si %parpadeo < 0,08·f y sin efecto observable si < 0,0333·f;
 * por debajo de 90 Hz, 0,025·f y 0,01·f.
 */
export function classifyFlickerRisk(percentFlicker: number, flickerFrequencyHz: number): FlickerRiskLevel {
  const isAboveNinetyHertz = flickerFrequencyHz > 90;
  const noEffectLimit = (isAboveNinetyHertz ? 0.0333 : 0.01) * flickerFrequencyHz;
  const lowRiskLimit = (isAboveNinetyHertz ? 0.08 : 0.025) * flickerFrequencyHz;
  if (percentFlicker < noEffectLimit) return 'noObservableEffect';
  if (percentFlicker < lowRiskLimit) return 'lowRisk';
  return 'aboveLowRisk';
}

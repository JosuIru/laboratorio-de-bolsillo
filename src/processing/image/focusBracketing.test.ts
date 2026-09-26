import {
  estimateBestFocus,
  type FocusMeasurement,
  type FocusSeriesOptions,
  initialFocusSeries,
  measureLunarFocusScore,
  proposeNextFocusSeries,
} from './focusBracketing';
import type { GrayImage } from './grayImage';
import { createCachedScene, createWaveTexture, renderSyntheticMoon } from './syntheticMoon.testHelpers';

const albedoTexture = createCachedScene(createWaveTexture(5, 40, 1 / 40, 1 / 5, 0.25), -40, 40, 0.25);
/** Posición de enfoque perfecta del «objetivo» simulado. */
const trueBestFocusPosition = 0.37;

/** Desenfoque en función de la posición: mínimo 0,6 px (difracción y lente) y crece en V. */
function blurSigmaForPosition(focusPosition: number): number {
  return 0.6 + 6 * Math.abs(focusPosition - trueBestFocusPosition);
}

let renderSeed = 1;
function photographAtFocus(focusPosition: number): GrayImage {
  renderSeed++;
  return renderSyntheticMoon({
    width: 96,
    height: 96,
    centerX: 48.2,
    centerY: 47.7,
    radius: 30,
    phaseAngleDegrees: 40,
    diskBrightness: 200,
    backgroundBrightness: 5,
    albedo: albedoTexture,
    blurSigmaPixels: blurSigmaForPosition(focusPosition),
    noiseSigma: 1,
    randomSeed: renderSeed,
    subsamplesPerSide: 3,
  });
}

function measureAt(focusPosition: number): FocusMeasurement {
  return { focusPosition, score: measureLunarFocusScore(photographAtFocus(focusPosition))!.score };
}

const seriesOptions: FocusSeriesOptions = { stepCount: 5, minimumStepSize: 0.01, minimumPosition: 0, maximumPosition: 1 };

describe('puntuación de nitidez de la Luna', () => {
  it('decrece con el desenfoque y el σ del limbo sigue al real', () => {
    const scores = [0.6, 1.2, 2, 3].map((blurSigma) => {
      const image = renderSyntheticMoon({
        width: 96, height: 96, centerX: 48, centerY: 48, radius: 30, albedo: albedoTexture, blurSigmaPixels: blurSigma, noiseSigma: 1, subsamplesPerSide: 3,
      });
      return measureLunarFocusScore(image)!;
    });
    for (let scoreIndex = 1; scoreIndex < scores.length; scoreIndex++) {
      expect(scores[scoreIndex]!.score).toBeLessThan(scores[scoreIndex - 1]!.score);
    }
    expect(scores[2]!.limbEdgeSigmaPixels).toBeCloseTo(2, 0);
  });

  it('devuelve null sin Luna', () => {
    expect(measureLunarFocusScore({ width: 32, height: 32, values: new Float32Array(32 * 32) })).toBeNull();
  });
});

describe('serie de enfoque', () => {
  it('elige la foto más nítida de una serie', () => {
    const measurements = initialFocusSeries(seriesOptions).map(measureAt);
    const bestFocus = estimateBestFocus(measurements)!;
    expect(bestFocus.bestMeasuredPosition).toBeCloseTo(0.25, 5);
    expect(bestFocus.isBracketed).toBe(true);
    expect(Math.abs(bestFocus.estimatedBestPosition - trueBestFocusPosition)).toBeLessThan(0.125);
  });

  it('el refinamiento converge al mejor enfoque', () => {
    const measurements: FocusMeasurement[] = initialFocusSeries(seriesOptions).map(measureAt);
    let proposal = proposeNextFocusSeries(measurements, seriesOptions);
    let roundCount = 1;
    while (!proposal.hasConverged && roundCount < 8) {
      measurements.push(...proposal.nextPositions.map(measureAt));
      proposal = proposeNextFocusSeries(measurements, seriesOptions);
      roundCount++;
    }
    expect(proposal.hasConverged).toBe(true);
    expect(roundCount).toBeLessThanOrEqual(5);
    expect(Math.abs(proposal.estimatedBestPosition - trueBestFocusPosition)).toBeLessThan(0.03);
  });

  it('si la mejor está en un extremo, desplaza la serie hacia fuera', () => {
    const measurements: FocusMeasurement[] = [0.6, 0.7, 0.8].map((focusPosition) => ({
      focusPosition,
      score: 1 / blurSigmaForPosition(focusPosition),
    }));
    const proposal = proposeNextFocusSeries(measurements, seriesOptions);
    expect(proposal.hasConverged).toBe(false);
    expect(Math.max(...proposal.nextPositions)).toBeLessThan(0.6);
    expect(Math.min(...proposal.nextPositions)).toBeCloseTo(0.2, 5);
  });

  it('en el límite del rango da el límite como óptimo', () => {
    const measurements: FocusMeasurement[] = [0, 0.1, 0.2].map((focusPosition) => ({ focusPosition, score: 1 - focusPosition }));
    const proposal = proposeNextFocusSeries(measurements, seriesOptions);
    expect(proposal.hasConverged).toBe(true);
    expect(proposal.estimatedBestPosition).toBe(0);
  });
});

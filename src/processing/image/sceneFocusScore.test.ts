import { chooseBestFocusPosition, focusBracketPositions, measureSceneFocusScore } from './sceneFocusScore';
import { createSceneWaves, renderSyntheticFrame } from './superzoomSynthetic.testHelpers';

const frameSize = 96;
const sceneWaves = createSceneWaves(99);
const stillMotion = { rotationDegrees: 0, translationX: 0, translationY: 0, rollingShutterShear: 0 };

function renderWithBlur(blurSigmaPixels: number, exposureGain = 1): Uint8Array {
  const rgbPixels = renderSyntheticFrame(sceneWaves, {
    size: frameSize,
    motion: stillMotion,
    opticalBlurSigmaPixels: blurSigmaPixels,
    noiseSigma: 1,
    noiseSeed: 5,
  });
  return Uint8Array.from(rgbPixels, (value) => Math.min(255, Math.round(value * exposureGain)));
}

describe('measureSceneFocusScore', () => {
  it('puntúa más la foto más nítida, aunque cambie un poco la exposición', () => {
    const scores = [0.6, 1.2, 2.4].map((blurSigma, blurIndex) =>
      measureSceneFocusScore(renderWithBlur(blurSigma, blurIndex === 0 ? 0.9 : 1.05), frameSize, frameSize),
    );
    expect(scores[0]!).toBeGreaterThan(scores[1]!);
    expect(scores[1]!).toBeGreaterThan(scores[2]!);
  });
});

describe('horquilla de enfoque', () => {
  it('centra las posiciones en la actual sin salirse de 0…1', () => {
    expect(focusBracketPositions(0.5, 0.05, 5)).toEqual([0.4, 0.45, 0.5, 0.55, 0.6].map((position) => expect.closeTo(position, 10)));
    expect(focusBracketPositions(0.98, 0.05, 5)).toEqual([0.88, 0.93, 0.98, 1].map((position) => expect.closeTo(position, 10)));
  });

  it('elige el vértice de la parábola entre las posiciones medidas', () => {
    // Desenfoque creciente al alejarse de 0,52 (el óptimo real).
    const positions = focusBracketPositions(0.5, 0.05, 5);
    const scores = positions.map((position) =>
      measureSceneFocusScore(renderWithBlur(0.6 + 12 * Math.abs(position - 0.52)), frameSize, frameSize),
    );
    const bestFocus = chooseBestFocusPosition(positions, scores);
    expect(bestFocus?.isBracketed).toBe(true);
    expect(Math.abs(bestFocus!.estimatedBestPosition - 0.52)).toBeLessThan(0.02);
  });
});

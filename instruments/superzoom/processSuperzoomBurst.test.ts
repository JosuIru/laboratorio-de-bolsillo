import { createSceneWaves, renderSyntheticFrame } from '@/processing/image/superzoomSynthetic.testHelpers';

import { deconvolveSingleFrame, processSuperzoomBurst } from './processSuperzoomBurst';

const cropSize = 96;
const sceneWaves = createSceneWaves(31, 16);
const frames = [0, 1, 2, 3, 4, 5].map((frameIndex) =>
  renderSyntheticFrame(sceneWaves, {
    size: cropSize,
    motion: { rotationDegrees: 0.1 * frameIndex, translationX: 0.6 * frameIndex, translationY: -0.35 * frameIndex, rollingShutterShear: 0 },
    opticalBlurSigmaPixels: 0.66,
    noiseSigma: 1.5,
    noiseSeed: frameIndex,
  }),
);
const photoGeometry = { photoWidth: 3024, photoHeight: 4032, cropLeft: 1464, cropTop: 1968 };

describe('processSuperzoomBurst', () => {
  it('fusiona, corrige el color y prepara los tres niveles de nitidez', () => {
    const result = processSuperzoomBurst(frames, cropSize, {
      useLocalAlignment: true,
      chromaticCorrectionMode: 'profile',
      zoomFactor: 1,
      ...photoGeometry,
    });
    expect(result.superzoomImage.size).toBe(2 * cropSize);
    expect(result.singleFrameImage.size).toBe(2 * cropSize);
    expect(result.chromatic.scales.redScale).toBeCloseTo(0.983, 5);
    expect(result.superzoomDeconvolution.images.strong.size).toBe(2 * cropSize);
    expect(result.superzoomDeconvolution.psfSigmaPixels).toBeGreaterThan(1.3);
    expect(result.timings.totalMilliseconds).toBeGreaterThanOrEqual(result.timings.mergeMilliseconds);
    expect(deconvolveSingleFrame(result).images.medium.size).toBe(2 * cropSize);
  });

  it('sin corrección de color, el superzoom es la fusión tal cual', () => {
    const result = processSuperzoomBurst(frames, cropSize, {
      useLocalAlignment: false,
      chromaticCorrectionMode: 'off',
      zoomFactor: 1,
      ...photoGeometry,
    });
    expect(result.superzoomImage).toBe(result.merge.image);
    expect(result.merge.locallyAlignedFrameCount).toBe(0);
  });
});

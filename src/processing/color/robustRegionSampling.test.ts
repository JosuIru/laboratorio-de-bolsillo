import { srgbComponentToLinear } from './colorSpaces';
import { createSrgbToLinearTable, measureRegionColor } from './regionSampling';
import { measureRegionColorRobust } from './robustRegionSampling';

describe('measureRegionColorRobust', () => {
  const frameWidth = 10;
  const frameHeight = 10;
  const bytesPerRow = frameWidth * 4;
  const lookupTable = createSrgbToLinearTable();
  const padColor = [200, 120, 60] as const;

  /** Almohadilla naranja con dos reflejos blancos y una sombra negra. */
  function createPadFrame(): Uint8Array {
    const rgbaPixels = new Uint8Array(bytesPerRow * frameHeight);
    for (let pixelIndex = 0; pixelIndex < frameWidth * frameHeight; pixelIndex++) {
      rgbaPixels.set([...padColor, 255], pixelIndex * 4);
    }
    rgbaPixels.set([255, 255, 255, 255], 0);
    rgbaPixels.set([255, 255, 255, 255], 4 * 11);
    rgbaPixels.set([0, 0, 0, 255], 4 * 55);
    return rgbaPixels;
  }
  const wholeFrame = { left: 0, top: 0, width: 1, height: 1 };

  it('ignora reflejos y sombras que desplazan la media simple', () => {
    const rgbaPixels = createPadFrame();
    const robustStatistics = measureRegionColorRobust(
      rgbaPixels,
      frameWidth,
      frameHeight,
      bytesPerRow,
      'rgba',
      wholeFrame,
      lookupTable,
    );
    const plainStatistics = measureRegionColor(rgbaPixels, frameWidth, frameHeight, bytesPerRow, 'rgba', wholeFrame, lookupTable);
    expect(robustStatistics!.meanLinear.red).toBeCloseTo(srgbComponentToLinear(padColor[0]), 12);
    expect(robustStatistics!.meanLinear.blue).toBeCloseTo(srgbComponentToLinear(padColor[2]), 12);
    expect(robustStatistics!.standardDeviationLinear.green).toBeCloseTo(0, 6);
    expect(plainStatistics!.meanLinear.blue).toBeGreaterThan(robustStatistics!.meanLinear.blue + 0.01);
  });

  it('sin recorte coincide con la media simple', () => {
    const rgbaPixels = createPadFrame();
    const robustStatistics = measureRegionColorRobust(
      rgbaPixels,
      frameWidth,
      frameHeight,
      bytesPerRow,
      'rgba',
      wholeFrame,
      lookupTable,
      1,
      0,
    );
    const plainStatistics = measureRegionColor(rgbaPixels, frameWidth, frameHeight, bytesPerRow, 'rgba', wholeFrame, lookupTable);
    expect(robustStatistics!.sampledPixelCount).toBe(100);
    expect(robustStatistics!.meanLinear.red).toBeCloseTo(plainStatistics!.meanLinear.red, 12);
  });

  it('con un solo píxel devuelve ese píxel y respeta BGRA', () => {
    const bgraPixels = new Uint8Array([10, 20, 30, 255]);
    const robustStatistics = measureRegionColorRobust(bgraPixels, 1, 1, 4, 'bgra', wholeFrame, lookupTable);
    expect(robustStatistics!.sampledPixelCount).toBe(1);
    expect(robustStatistics!.meanLinear.red).toBeCloseTo(srgbComponentToLinear(30), 12);
    expect(robustStatistics!.meanLinear.blue).toBeCloseTo(srgbComponentToLinear(10), 12);
  });

  it('devuelve null para una región fuera del fotograma', () => {
    expect(
      measureRegionColorRobust(createPadFrame(), frameWidth, frameHeight, bytesPerRow, 'rgba', { left: 2, top: 2, width: 1, height: 1 }, lookupTable),
    ).toBeNull();
  });
});

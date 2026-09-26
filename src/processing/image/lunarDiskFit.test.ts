import { fitCircleAlgebraic, fitLunarDisk, refineCircleGeometric, type EdgePoint } from './lunarDiskFit';
import { createWaveTexture, renderSyntheticMoon } from './syntheticMoon.testHelpers';

const imageSize = 96;
const trueRadius = 30;

function circlePoints(centerX: number, centerY: number, radius: number, startAngle: number, endAngle: number, count: number): EdgePoint[] {
  return Array.from({ length: count }, (_unused, pointIndex) => {
    const angle = startAngle + ((endAngle - startAngle) * pointIndex) / (count - 1);
    return {
      positionX: centerX + radius * Math.cos(angle),
      positionY: centerY + radius * Math.sin(angle),
      gradientDirectionX: -Math.cos(angle),
      gradientDirectionY: -Math.sin(angle),
      edgeContrast: 1,
    };
  });
}

describe('ajuste de círculos', () => {
  it('el algebraico y el geométrico recuperan un arco exacto', () => {
    const arcPoints = circlePoints(40.3, 51.7, 22.5, -1, 1.2, 30);
    const algebraicCircle = fitCircleAlgebraic(arcPoints)!;
    expect(algebraicCircle.radius).toBeCloseTo(22.5, 6);
    const geometricCircle = refineCircleGeometric(arcPoints, { centerX: 45, centerY: 48, radius: 18 });
    expect(geometricCircle.centerX).toBeCloseTo(40.3, 5);
    expect(geometricCircle.centerY).toBeCloseTo(51.7, 5);
    expect(geometricCircle.radius).toBeCloseTo(22.5, 5);
  });
});

describe('fitLunarDisk', () => {
  const phaseCases = [
    { description: 'llena', phaseAngleDegrees: 0, litDirectionDegrees: 0 },
    { description: 'gibosa', phaseAngleDegrees: 60, litDirectionDegrees: 20 },
    { description: 'cuarto', phaseAngleDegrees: 90, litDirectionDegrees: 180 },
    { description: 'creciente', phaseAngleDegrees: 125, litDirectionDegrees: -70 },
    { description: 'creciente fina', phaseAngleDegrees: 140, litDirectionDegrees: 110 },
  ];
  const centerCases = [
    { centerX: 48, centerY: 48 },
    { centerX: 45.37, centerY: 50.81 },
    { centerX: 51.9, centerY: 43.25 },
  ];

  for (const phaseCase of phaseCases) {
    it(`recupera centro y radio con precisión subpíxel en fase ${phaseCase.description}, con ruido y desenfoque`, () => {
      for (const [centerIndex, centerCase] of centerCases.entries()) {
        const moonImage = renderSyntheticMoon({
          width: imageSize,
          height: imageSize,
          ...centerCase,
          radius: trueRadius,
          phaseAngleDegrees: phaseCase.phaseAngleDegrees,
          litDirectionDegrees: phaseCase.litDirectionDegrees,
          diskBrightness: 180,
          backgroundBrightness: 12,
          blurSigmaPixels: 0.7,
          noiseSigma: 4,
          randomSeed: 100 + centerIndex,
        });
        const diskFit = fitLunarDisk(moonImage)!;
        expect(diskFit).not.toBeNull();
        expect(Math.abs(diskFit.radius - trueRadius)).toBeLessThan(0.3);
        expect(Math.hypot(diskFit.centerX - centerCase.centerX, diskFit.centerY - centerCase.centerY)).toBeLessThan(0.3);
      }
    });
  }

  it('no confunde el terminador con el limbo y cubre la mitad de la circunferencia en cuarto', () => {
    const moonImage = renderSyntheticMoon({
      width: imageSize,
      height: imageSize,
      centerX: 47.5,
      centerY: 48.2,
      radius: trueRadius,
      phaseAngleDegrees: 90,
      litDirectionDegrees: 0,
    });
    const diskFit = fitLunarDisk(moonImage)!;
    expect(diskFit.limbCoverageFraction).toBeGreaterThan(0.4);
    expect(diskFit.limbCoverageFraction).toBeLessThan(0.62);
    expect(diskFit.rmsResidualPixels).toBeLessThan(0.1);
    expect(Math.abs(diskFit.radius - trueRadius)).toBeLessThan(0.1);
  });

  it('tolera un albedo con manchas (mares) y sigue siendo subpíxel', () => {
    const albedoTexture = createWaveTexture(11, 16, 0.02, 0.1, 0.2);
    const moonImage = renderSyntheticMoon({
      width: imageSize,
      height: imageSize,
      centerX: 49.3,
      centerY: 46.6,
      radius: trueRadius,
      phaseAngleDegrees: 40,
      litDirectionDegrees: 135,
      albedo: albedoTexture,
      blurSigmaPixels: 0.8,
      noiseSigma: 3,
    });
    const diskFit = fitLunarDisk(moonImage)!;
    expect(Math.abs(diskFit.radius - trueRadius)).toBeLessThan(0.3);
    expect(Math.hypot(diskFit.centerX - 49.3, diskFit.centerY - 46.6)).toBeLessThan(0.3);
  });

  it('devuelve null en una imagen sin disco', () => {
    const emptyImage = renderSyntheticMoon({
      width: 64,
      height: 64,
      centerX: 32,
      centerY: 32,
      radius: 20,
      diskBrightness: 0,
      noiseSigma: 2,
    });
    expect(fitLunarDisk(emptyImage)).toBeNull();
  });
});

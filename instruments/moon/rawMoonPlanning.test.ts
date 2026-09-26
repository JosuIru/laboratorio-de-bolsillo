import { expectedRawMoonRadius, maximumRawRegionSide, planRawMoonRegion } from './rawMoonPlanning';

const uprightRawSize = { width: 3072, height: 4096 };

describe('zona de la Luna en el RAW', () => {
  it('sin zoom, escala el punto de la vista previa', () => {
    const detection = { centerX: 540, centerY: 720, radiusPixels: 10, frameWidth: 720, frameHeight: 960 };
    const region = planRawMoonRegion(detection, 1, uprightRawSize);
    expect(region.left + region.width / 2).toBeCloseTo((540 / 720) * 3072, -1);
    expect(region.top + region.height / 2).toBeCloseTo((720 / 960) * 4096, -1);
    expect(expectedRawMoonRadius(detection, 1, uprightRawSize)).toBeCloseTo(42.7, 1);
  });

  it('con zoom ×8, la Luna del borde de la vista previa está cerca del centro del RAW y es 8 veces menor', () => {
    const detection = { centerX: 600, centerY: 480, radiusPixels: 96, frameWidth: 720, frameHeight: 960 };
    const region = planRawMoonRegion(detection, 8, uprightRawSize);
    const expectedCenterX = 1536 + ((600 / 720) * 3072 - 1536) / 8;
    expect(region.left + region.width / 2).toBeCloseTo(expectedCenterX, -1);
    expect(region.top + region.height / 2).toBeCloseTo(2048, -1);
    expect(expectedRawMoonRadius(detection, 8, uprightRawSize)).toBeCloseTo(51.2, 1);
    expect(region.width).toBeLessThanOrEqual(maximumRawRegionSide);
    expect(region.width).toBeGreaterThan(5 * 51.2);
  });
});

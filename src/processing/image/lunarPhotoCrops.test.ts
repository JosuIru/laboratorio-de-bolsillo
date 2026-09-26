import { medianValue, moonCropFromRegion, moonSearchRegionSide } from './lunarPhotoCrops';

/** Zona RGB con un disco brillante sobre fondo oscuro. */
function renderDiskRegion(regionWidth: number, regionHeight: number, centerX: number, centerY: number, radius: number) {
  const regionRgb = new Uint8Array(regionWidth * regionHeight * 3);
  for (let rowIndex = 0; rowIndex < regionHeight; rowIndex++) {
    for (let columnIndex = 0; columnIndex < regionWidth; columnIndex++) {
      const coverage = Math.max(0, Math.min(1, radius - Math.hypot(columnIndex - centerX, rowIndex - centerY) + 0.5));
      const value = Math.round(10 + coverage * 190);
      regionRgb.fill(value, (rowIndex * regionWidth + columnIndex) * 3, (rowIndex * regionWidth + columnIndex) * 3 + 3);
    }
  }
  return regionRgb;
}

describe('zona de búsqueda de la Luna en la foto', () => {
  it('a simple vista (Luna de ~27 px) basta una zona pequeña con margen para la deriva', () => {
    const regionSide = moonSearchRegionSide(13.5, 3088);
    expect(regionSide).toBeGreaterThanOrEqual(256);
    expect(regionSide).toBeLessThan(600);
  });

  it('por un ocular (Luna enorme) la zona abarca la Luna con margen, sin salirse de la foto', () => {
    expect(moonSearchRegionSide(600, 3088)).toBeGreaterThan(1800);
    expect(moonSearchRegionSide(2000, 3088)).toBe(3088);
  });
});

describe('recorte centrado en la Luna dentro de la zona', () => {
  it('encuentra el disco y lo deja en el centro del recorte', () => {
    const regionRgb = renderDiskRegion(200, 160, 120.3, 70.6, 20);
    const moonCrop = moonCropFromRegion(regionRgb, 200, 160, 64);
    expect(moonCrop).not.toBeNull();
    expect(moonCrop!.detection.centerX).toBeCloseTo(120.3, 0);
    expect(moonCrop!.detection.centerY).toBeCloseTo(70.6, 0);
    // El centro del recorte (32, 32) es brillante; la esquina, oscura.
    const centerOffset = (32 * 64 + 32) * 3;
    expect(moonCrop!.alignedCrop.rgbPixels[centerOffset]).toBeGreaterThan(150);
    expect(moonCrop!.alignedCrop.rgbPixels[0]).toBeLessThan(20);
  });

  it('sin Luna en la zona devuelve null', () => {
    expect(moonCropFromRegion(new Uint8Array(100 * 100 * 3).fill(12), 100, 100, 64)).toBeNull();
  });
});

describe('mediana', () => {
  it('no se deja llevar por un valor raro', () => {
    expect(medianValue([10, 11, 400, 12, 11])).toBe(11);
    expect(medianValue([4, 6])).toBe(5);
    expect(medianValue([])).toBe(0);
  });
});

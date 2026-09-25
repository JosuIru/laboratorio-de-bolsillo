import { buildThumbnailMosaic, glowColor, renderThumbnailToRgba } from './thumbnailRendering';

describe('glowColor', () => {
  it('va de negro a blanco pasando por rojo', () => {
    expect(glowColor(0)).toEqual([0, 0, 0]);
    expect(glowColor(1)).toEqual([255, 255, 255]);
    const [redValue, greenValue, blueValue] = glowColor(0.4);
    expect(redValue).toBeGreaterThan(greenValue);
    expect(blueValue).toBe(0);
  });
});

describe('renderThumbnailToRgba', () => {
  it('amplía cada píxel un número entero de veces y estira el contraste', () => {
    const thumbnailPixels = new Uint8Array(16).fill(5);
    thumbnailPixels[5] = 80;
    const rgbaImage = renderThumbnailToRgba({ pixels: thumbnailPixels, side: 4 }, 10);
    expect(rgbaImage.width).toBe(8);
    const brightOffset = (2 * 8 + 2) * 4;
    expect(Array.from(rgbaImage.rgbaPixels.subarray(brightOffset, brightOffset + 4))).toEqual([255, 255, 255, 255]);
    expect(Array.from(rgbaImage.rgbaPixels.subarray(0, 4))).toEqual([0, 0, 0, 255]);
  });
});

describe('buildThumbnailMosaic', () => {
  it('coloca las miniaturas en una rejilla con separación', () => {
    const thumbnail = { pixels: new Uint8Array(16 * 16).fill(40), side: 16 };
    const mosaic = buildThumbnailMosaic([thumbnail, thumbnail, thumbnail], 32, 2, 4)!;
    expect(mosaic.width).toBe(2 * 32 + 3 * 4);
    expect(mosaic.height).toBe(2 * 32 + 3 * 4);
    expect(mosaic.rgbaPixels).toHaveLength(mosaic.width * mosaic.height * 4);
  });

  it('sin miniaturas no hay mosaico', () => {
    expect(buildThumbnailMosaic([], 32, 4, 2)).toBeNull();
  });
});

import {
  bytesToRgba,
  captureRegionFor,
  centerCropSide,
  clampIso,
  formatElapsedTime,
  frameSourceFromGrayFrames,
  grayBytesFromRgb,
  nightExposureSeconds,
  wholeFieldMaximumSide,
} from './skyCapturePlanning';

describe('planificación de la captura del cielo', () => {
  const photoSize = { width: 3024, height: 4032 };

  it('elige la zona de la foto según el campo', () => {
    expect(captureRegionFor('whole', photoSize)).toEqual({
      cropRect: { left: 0, top: 0, width: 3024, height: 4032 },
      maximumOutputSide: wholeFieldMaximumSide,
    });
    const centerRegion = captureRegionFor('center', photoSize);
    expect(centerRegion.cropRect.width).toBe(centerCropSide);
    expect(centerRegion.cropRect.left + centerRegion.cropRect.width / 2).toBeCloseTo(1512, 0);
    expect(centerRegion.maximumOutputSide).toBeUndefined();
  });

  it('ajusta ISO y exposición a lo que admite el móvil', () => {
    expect(clampIso(6400, 50, 3200)).toBe(3200);
    expect(clampIso(1600, 50, 6400)).toBe(1600);
    expect(nightExposureSeconds(0.185)).toBe(0.185);
    expect(nightExposureSeconds(30)).toBe(2);
  });

  it('convierte píxeles para mostrar y apilar', () => {
    expect(Array.from(grayBytesFromRgb(Uint8Array.from([255, 255, 255, 100, 0, 0]), 2))).toEqual([255, 30]);
    expect(Array.from(bytesToRgba(Uint8Array.from([7]), 1, 1))).toEqual([7, 7, 7, 255]);
    expect(Array.from(bytesToRgba(Uint8Array.from([1, 2, 3]), 1, 3))).toEqual([1, 2, 3, 255]);
    const frameSource = frameSourceFromGrayFrames([{ grayBytes: Uint8Array.from([1, 2, 3, 4]), width: 2, height: 2 }]);
    expect(frameSource.frameCount).toBe(1);
    expect(Array.from(frameSource.loadFrame(0).values)).toEqual([1, 2, 3, 4]);
  });

  it('formatea la duración', () => {
    expect(formatElapsedTime(65_000)).toBe('1:05');
    expect(formatElapsedTime(3_725_000)).toBe('1:02:05');
  });
});

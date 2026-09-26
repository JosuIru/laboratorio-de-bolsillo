import { exifOrientationToTransform, rawPixelsToRgb, readJpegExifOrientation } from './jpegPhoto';

/** Cabecera JPEG mínima con un segmento APP1 EXIF que solo lleva la orientación. */
function jpegHeaderWithOrientation(orientation: number, isLittleEndian: boolean): Uint8Array {
  const writeUint16 = (value: number) => (isLittleEndian ? [value & 0xff, value >> 8] : [value >> 8, value & 0xff]);
  const writeUint32 = (value: number) =>
    isLittleEndian
      ? [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24]
      : [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  const tiffBlock = [
    ...(isLittleEndian ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...writeUint16(42),
    ...writeUint32(8),
    ...writeUint16(1), // una entrada
    ...writeUint16(0x0112),
    ...writeUint16(3), // SHORT
    ...writeUint32(1),
    ...writeUint16(orientation),
    0,
    0,
    ...writeUint32(0),
  ];
  const app1Data = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiffBlock];
  const app1Length = app1Data.length + 2;
  // Un segmento APP0 (JFIF) antes del EXIF, como en muchos JPEG.
  const app0Segment = [0xff, 0xe0, 0, 7, 0x4a, 0x46, 0x49, 0x46, 0];
  return new Uint8Array([
    0xff,
    0xd8,
    ...app0Segment,
    0xff,
    0xe1,
    app1Length >> 8,
    app1Length & 0xff,
    ...app1Data,
    0xff,
    0xda,
    0,
    2,
  ]);
}

describe('orientación EXIF de un JPEG', () => {
  it.each([1, 3, 6, 8])('lee la orientación %i en los dos órdenes de bytes', (orientation) => {
    expect(readJpegExifOrientation(jpegHeaderWithOrientation(orientation, true))).toBe(orientation);
    expect(readJpegExifOrientation(jpegHeaderWithOrientation(orientation, false))).toBe(orientation);
  });

  it('sin EXIF, cortado o sin ser JPEG se da por derecha', () => {
    expect(readJpegExifOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBe(1);
    expect(readJpegExifOrientation(jpegHeaderWithOrientation(6, true).slice(0, 20))).toBe(1);
    expect(readJpegExifOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(1);
  });

  it('traduce la orientación a giro horario y espejo', () => {
    expect(exifOrientationToTransform(1)).toEqual({ clockwiseDegrees: 0, isMirrored: false });
    expect(exifOrientationToTransform(6)).toEqual({ clockwiseDegrees: 90, isMirrored: false });
    expect(exifOrientationToTransform(3)).toEqual({ clockwiseDegrees: 180, isMirrored: false });
    expect(exifOrientationToTransform(8)).toEqual({ clockwiseDegrees: 270, isMirrored: false });
    expect(exifOrientationToTransform(5)).toEqual({ clockwiseDegrees: 90, isMirrored: true });
    expect(exifOrientationToTransform(99)).toEqual({ clockwiseDegrees: 0, isMirrored: false });
  });
});

describe('píxeles decodificados a RGB', () => {
  it('reordena los canales según el formato y salta el relleno de cada fila', () => {
    // 2 × 2 en BGRA, con 4 bytes de relleno por fila.
    const bgraPixels = new Uint8Array([
      3, 2, 1, 255, 6, 5, 4, 255, 0, 0, 0, 0,
      9, 8, 7, 255, 12, 11, 10, 255, 0, 0, 0, 0,
    ]);
    expect(Array.from(rawPixelsToRgb(bgraPixels, 2, 2, 12, 'BGRA'))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('entiende RGBA y ARGB', () => {
    expect(Array.from(rawPixelsToRgb(new Uint8Array([10, 20, 30, 255]), 1, 1, 4, 'RGBA'))).toEqual([10, 20, 30]);
    expect(Array.from(rawPixelsToRgb(new Uint8Array([255, 10, 20, 30]), 1, 1, 4, 'ARGB'))).toEqual([10, 20, 30]);
  });

  it('avisa si el búfer no alcanza', () => {
    expect(() => rawPixelsToRgb(new Uint8Array(10), 2, 2, 8, 'RGBA')).toThrow();
  });
});

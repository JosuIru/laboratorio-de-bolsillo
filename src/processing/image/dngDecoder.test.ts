import { byteSourceFromBytes, DngFormatProblem, parseDngRawLayout, readMosaicRegion, shiftBayerPattern } from './dngDecoder';
import { extractGreenChannel } from './greenChannelMono';

interface TestIfdEntry {
  tag: number;
  type: number;
  values: number[];
}

/** Escribe un TIFF mínimo: cabecera, IFD0 (y un SubIFD opcional) y los datos a continuación. */
function buildTiff(
  ifd0Entries: TestIfdEntry[],
  subIfdEntries: TestIfdEntry[] | null,
  imageData: Uint8Array,
  isLittleEndian: boolean,
  dataTagForOffsets: number,
): Uint8Array {
  const typeSizes: Record<number, number> = { 1: 1, 3: 2, 4: 4, 5: 8 };
  const ifdByteLength = (entries: TestIfdEntry[]) => 2 + entries.length * 12 + 4;
  const extraByteLength = (entries: TestIfdEntry[]) =>
    entries.reduce((sum, entry) => {
      const byteLength = typeSizes[entry.type]! * entry.values.length;
      return sum + (byteLength > 4 ? byteLength : 0);
    }, 0);
  const allEntries = [ifd0Entries, ...(subIfdEntries ? [subIfdEntries] : [])];
  // Se añaden las entradas que dependen de las posiciones con valores provisionales.
  const ifd0Offset = 8;
  const subIfdOffset = ifd0Offset + ifdByteLength(ifd0Entries) + extraByteLength(ifd0Entries);
  const dataOffset = subIfdOffset + (subIfdEntries ? ifdByteLength(subIfdEntries) + extraByteLength(subIfdEntries) : 0);
  const totalLength = dataOffset + imageData.length;
  const fileBytes = new Uint8Array(totalLength);
  const view = new DataView(fileBytes.buffer);
  fileBytes.set(isLittleEndian ? [0x49, 0x49] : [0x4d, 0x4d], 0);
  view.setUint16(2, 42, isLittleEndian);
  view.setUint32(4, ifd0Offset, isLittleEndian);
  const writeValue = (position: number, type: number, value: number) => {
    if (type === 1) view.setUint8(position, value);
    else if (type === 3) view.setUint16(position, value, isLittleEndian);
    else if (type === 4) view.setUint32(position, value, isLittleEndian);
    else if (type === 5) {
      view.setUint32(position, Math.round(value * 1000), isLittleEndian);
      view.setUint32(position + 4, 1000, isLittleEndian);
    }
  };
  const writeIfd = (entries: TestIfdEntry[], ifdOffset: number) => {
    const sortedEntries = [...entries].sort((first, second) => first.tag - second.tag);
    view.setUint16(ifdOffset, sortedEntries.length, isLittleEndian);
    let extraOffset = ifdOffset + ifdByteLength(sortedEntries);
    sortedEntries.forEach((entry, entryIndex) => {
      const entryOffset = ifdOffset + 2 + entryIndex * 12;
      const values = entry.tag === 330 ? [subIfdOffset] : entry.tag === dataTagForOffsets ? entry.values.map((value) => value + dataOffset) : entry.values;
      view.setUint16(entryOffset, entry.tag, isLittleEndian);
      view.setUint16(entryOffset + 2, entry.type, isLittleEndian);
      view.setUint32(entryOffset + 4, values.length, isLittleEndian);
      const byteLength = typeSizes[entry.type]! * values.length;
      const valuePosition = byteLength <= 4 ? entryOffset + 8 : extraOffset;
      if (byteLength > 4) {
        view.setUint32(entryOffset + 8, extraOffset, isLittleEndian);
        extraOffset += byteLength;
      }
      values.forEach((value, valueIndex) => writeValue(valuePosition + valueIndex * typeSizes[entry.type]!, entry.type, value));
    });
    view.setUint32(ifdOffset + 2 + sortedEntries.length * 12, 0, isLittleEndian);
  };
  writeIfd(allEntries[0]!, ifd0Offset);
  if (subIfdEntries) writeIfd(subIfdEntries, subIfdOffset);
  fileBytes.set(imageData, dataOffset);
  return fileBytes;
}

const rawWidth = 16;
const rawHeight = 12;
/** Valor crudo conocido en cada fotosito, para comprobar que se lee el sitio correcto. */
function rawValueAt(columnIndex: number, rowIndex: number): number {
  return 64 + rowIndex * 50 + columnIndex;
}

function rawImageBytes(isLittleEndian: boolean): Uint8Array {
  const imageBytes = new Uint8Array(rawWidth * rawHeight * 2);
  const view = new DataView(imageBytes.buffer);
  for (let rowIndex = 0; rowIndex < rawHeight; rowIndex++) {
    for (let columnIndex = 0; columnIndex < rawWidth; columnIndex++) {
      view.setUint16((rowIndex * rawWidth + columnIndex) * 2, rawValueAt(columnIndex, rowIndex), isLittleEndian);
    }
  }
  return imageBytes;
}

function rawEntries(extraEntries: TestIfdEntry[] = []): TestIfdEntry[] {
  const rowsPerStrip = 5;
  const stripCount = Math.ceil(rawHeight / rowsPerStrip);
  return [
    { tag: 254, type: 4, values: [0] },
    { tag: 256, type: 4, values: [rawWidth] },
    { tag: 257, type: 4, values: [rawHeight] },
    { tag: 258, type: 3, values: [16] },
    { tag: 259, type: 3, values: [1] },
    { tag: 262, type: 3, values: [32803] },
    { tag: 273, type: 4, values: Array.from({ length: stripCount }, (_unused, stripIndex) => stripIndex * rowsPerStrip * rawWidth * 2) },
    { tag: 278, type: 4, values: [rowsPerStrip] },
    { tag: 33421, type: 3, values: [2, 2] },
    { tag: 33422, type: 1, values: [2, 1, 1, 0] },
    { tag: 50714, type: 5, values: [64, 64, 64, 64] },
    { tag: 50717, type: 3, values: [1023] },
    ...extraEntries,
  ];
}

describe('lectura de DNG sin comprimir', () => {
  it.each([true, false])('encuentra la imagen RAW en el IFD0 (little-endian = %s) y lee una zona', (isLittleEndian) => {
    const fileBytes = buildTiff([...rawEntries(), { tag: 274, type: 3, values: [6] }], null, rawImageBytes(isLittleEndian), isLittleEndian, 273);
    const byteSource = byteSourceFromBytes(fileBytes);
    const layout = parseDngRawLayout(byteSource);
    expect(layout).toMatchObject({ width: rawWidth, height: rawHeight, bitsPerSample: 16, bayerPattern: 'BGGR', blackLevel: 64, whiteLevel: 1023, orientation: 6 });
    // Zona que cruza dos tiras y empieza en coordenadas impares (se ajusta a pares).
    const region = readMosaicRegion(byteSource, layout, { left: 3, top: 3, width: 8, height: 6 });
    expect(region.width).toBe(8);
    expect(region.height).toBe(6);
    expect(region.bayerPattern).toBe('BGGR');
    for (let rowIndex = 0; rowIndex < region.height; rowIndex++) {
      for (let columnIndex = 0; columnIndex < region.width; columnIndex++) {
        expect(region.values[rowIndex * region.width + columnIndex]).toBe(rawValueAt(2 + columnIndex, 2 + rowIndex));
      }
    }
    const greenImage = extractGreenChannel(region.values, region.width, region.height, {
      pattern: region.bayerPattern,
      blackLevel: layout.blackLevel,
      whiteLevel: layout.whiteLevel,
    });
    expect(greenImage.width).toBe(4);
    // En BGGR los verdes de la primera celda están en (1, 0) y (0, 1).
    const expectedFirstGreen = (rawValueAt(3, 2) + rawValueAt(2, 3)) / 2;
    expect(greenImage.values[0]).toBeCloseTo((expectedFirstGreen - 64) / (1023 - 64), 5);
  });

  it('sigue los SubIFD cuando el IFD0 es la miniatura', () => {
    const thumbnailEntries: TestIfdEntry[] = [
      { tag: 254, type: 4, values: [1] },
      { tag: 256, type: 4, values: [4] },
      { tag: 257, type: 4, values: [3] },
      { tag: 262, type: 3, values: [2] },
      { tag: 274, type: 3, values: [8] },
      { tag: 330, type: 4, values: [0] },
    ];
    const fileBytes = buildTiff(thumbnailEntries, rawEntries(), rawImageBytes(true), true, 273);
    const layout = parseDngRawLayout(byteSourceFromBytes(fileBytes));
    expect(layout.width).toBe(rawWidth);
    expect(layout.orientation).toBe(8);
  });

  it('avisa si viene comprimido, si no es TIFF o si el patrón no es de Bayer', () => {
    const compressedEntries = rawEntries().map((entry) => (entry.tag === 259 ? { ...entry, values: [7] } : entry));
    const expectProblem = (fileBytes: Uint8Array, problemCode: string) => {
      try {
        parseDngRawLayout(byteSourceFromBytes(fileBytes));
        throw new Error('debería haber fallado');
      } catch (problem) {
        expect(problem).toBeInstanceOf(DngFormatProblem);
        expect((problem as DngFormatProblem).problemCode).toBe(problemCode);
      }
    };
    expectProblem(buildTiff(compressedEntries, null, rawImageBytes(true), true, 273), 'compressed');
    expectProblem(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 'notTiff');
    const oddPatternEntries = rawEntries().map((entry) => (entry.tag === 33422 ? { ...entry, values: [0, 1, 2, 1] } : entry));
    expectProblem(buildTiff(oddPatternEntries, null, rawImageBytes(true), true, 273), 'unsupportedCfaPattern');
  });

  it('lee teselas', () => {
    const tileSide = 8;
    const tilesAcross = rawWidth / tileSide;
    const tilesDown = Math.ceil(rawHeight / tileSide);
    const tiledBytes = new Uint8Array(tilesAcross * tilesDown * tileSide * tileSide * 2);
    const tiledView = new DataView(tiledBytes.buffer);
    for (let tileRow = 0; tileRow < tilesDown; tileRow++) {
      for (let tileColumn = 0; tileColumn < tilesAcross; tileColumn++) {
        const tileStart = (tileRow * tilesAcross + tileColumn) * tileSide * tileSide * 2;
        for (let rowInTile = 0; rowInTile < tileSide; rowInTile++) {
          for (let columnInTile = 0; columnInTile < tileSide; columnInTile++) {
            const imageRow = tileRow * tileSide + rowInTile;
            const imageColumn = tileColumn * tileSide + columnInTile;
            const value = imageRow < rawHeight ? rawValueAt(imageColumn, imageRow) : 0;
            tiledView.setUint16(tileStart + (rowInTile * tileSide + columnInTile) * 2, value, true);
          }
        }
      }
    }
    const tiledEntries = rawEntries()
      .filter((entry) => entry.tag !== 273 && entry.tag !== 278)
      .concat([
        { tag: 322, type: 3, values: [tileSide] },
        { tag: 323, type: 3, values: [tileSide] },
        {
          tag: 324,
          type: 4,
          values: Array.from({ length: tilesAcross * tilesDown }, (_unused, tileIndex) => tileIndex * tileSide * tileSide * 2),
        },
      ]);
    const byteSource = byteSourceFromBytes(buildTiff(tiledEntries, null, tiledBytes, true, 324));
    const layout = parseDngRawLayout(byteSource);
    const region = readMosaicRegion(byteSource, layout, { left: 6, top: 6, width: 6, height: 4 });
    for (let rowIndex = 0; rowIndex < region.height; rowIndex++) {
      for (let columnIndex = 0; columnIndex < region.width; columnIndex++) {
        expect(region.values[rowIndex * region.width + columnIndex]).toBe(rawValueAt(6 + columnIndex, 6 + rowIndex));
      }
    }
  });

  it('desplaza el patrón de Bayer', () => {
    expect(shiftBayerPattern('RGGB', 1, 0)).toBe('GRBG');
    expect(shiftBayerPattern('RGGB', 0, 1)).toBe('GBRG');
    expect(shiftBayerPattern('RGGB', 1, 1)).toBe('BGGR');
    expect(shiftBayerPattern('BGGR', 2, 4)).toBe('BGGR');
  });
});

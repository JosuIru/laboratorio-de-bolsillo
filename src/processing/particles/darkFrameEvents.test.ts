import {
  accumulateBrightnessHistogram,
  classifyParticleShape,
  copyBrightnessThumbnail,
  defaultParticleDetectionOptions,
  describeCluster,
  detectParticleEventsInFrame,
  findSeedPixels,
  type FramePixelLayout,
  groupSeedsIntoClusters,
  isHotPixel,
  sampleDarkLevel,
  thumbnailSideForCluster,
} from './darkFrameEvents';

/** Generador pseudoaleatorio reproducible (LCG) para el ruido de los fotogramas sintéticos. */
function createRandomGenerator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

interface SyntheticFrame {
  pixels: Uint8Array;
  layout: FramePixelLayout;
  setBrightness(columnIndex: number, rowIndex: number, brightness: number, channel?: number): void;
}

/**
 * Fotograma negro con ruido de ±`noiseAmplitude` sobre `darkLevel`, en RGBA o RGB y con relleno
 * al final de cada fila (como los búferes reales).
 */
function createDarkFrame({
  frameWidth = 64,
  frameHeight = 48,
  bytesPerPixel = 4,
  rowPaddingBytes = 12,
  darkLevel = 4,
  noiseAmplitude = 2,
  seed = 7,
}: {
  frameWidth?: number;
  frameHeight?: number;
  bytesPerPixel?: 3 | 4;
  rowPaddingBytes?: number;
  darkLevel?: number;
  noiseAmplitude?: number;
  seed?: number;
} = {}): SyntheticFrame {
  const bytesPerRow = frameWidth * bytesPerPixel + rowPaddingBytes;
  const pixels = new Uint8Array(bytesPerRow * frameHeight);
  const nextRandom = createRandomGenerator(seed);
  for (let rowIndex = 0; rowIndex < frameHeight; rowIndex++) {
    for (let columnIndex = 0; columnIndex < frameWidth; columnIndex++) {
      const pixelOffset = rowIndex * bytesPerRow + columnIndex * bytesPerPixel;
      for (let channel = 0; channel < 3; channel++) {
        const noise = Math.round((nextRandom() * 2 - 1) * noiseAmplitude);
        pixels[pixelOffset + channel] = Math.max(0, darkLevel + noise);
      }
      if (bytesPerPixel === 4) pixels[pixelOffset + 3] = 255;
    }
    // Basura en el relleno: no debe leerse nunca.
    for (let paddingByte = frameWidth * bytesPerPixel; paddingByte < bytesPerRow; paddingByte++) {
      pixels[rowIndex * bytesPerRow + paddingByte] = 250;
    }
  }
  const layout: FramePixelLayout = { frameWidth, frameHeight, bytesPerRow, bytesPerPixel };
  return {
    pixels,
    layout,
    setBrightness(columnIndex, rowIndex, brightness, channel = 1) {
      pixels[rowIndex * bytesPerRow + columnIndex * bytesPerPixel + channel] = brightness;
    },
  };
}

const noHotPixels = new Int32Array(0);

describe('nivel de negro e histograma', () => {
  it('estima el nivel de negro con el máximo de los canales', () => {
    const syntheticFrame = createDarkFrame({ darkLevel: 10, noiseAmplitude: 0 });
    expect(sampleDarkLevel(syntheticFrame.pixels, syntheticFrame.layout, 4)).toBe(10);
  });

  it('el histograma cuenta cada muestra una vez y no lee el relleno de las filas', () => {
    const syntheticFrame = createDarkFrame({ noiseAmplitude: 0, darkLevel: 3 });
    const histogram = new Uint32Array(256);
    accumulateBrightnessHistogram(syntheticFrame.pixels, syntheticFrame.layout, 1, histogram);
    expect(histogram[3]).toBe(64 * 48);
    expect(histogram[250]).toBe(0);
  });
});

describe('isHotPixel', () => {
  it('encuentra los índices de una lista ordenada', () => {
    const sortedIndices = Int32Array.from([3, 10, 57, 900, 1200]);
    expect(isHotPixel(sortedIndices, 57)).toBe(true);
    expect(isHotPixel(sortedIndices, 1200)).toBe(true);
    expect(isHotPixel(sortedIndices, 3)).toBe(true);
    expect(isHotPixel(sortedIndices, 58)).toBe(false);
    expect(isHotPixel(noHotPixels, 0)).toBe(false);
  });
});

describe('findSeedPixels', () => {
  it('encuentra los píxeles brillantes y respeta la máscara', () => {
    const syntheticFrame = createDarkFrame({ bytesPerPixel: 3 });
    syntheticFrame.setBrightness(5, 6, 200, 0);
    syntheticFrame.setBrightness(40, 30, 180, 2);
    const hotPixelIndex = 30 * 64 + 40;
    const withoutMask = findSeedPixels(syntheticFrame.pixels, syntheticFrame.layout, 30, noHotPixels, 100);
    expect(withoutMask.seedIndices).toEqual([6 * 64 + 5, hotPixelIndex]);
    const withMask = findSeedPixels(
      syntheticFrame.pixels,
      syntheticFrame.layout,
      30,
      Int32Array.from([hotPixelIndex]),
      100,
    );
    expect(withMask.seedIndices).toEqual([6 * 64 + 5]);
    expect(withMask.isOverflowing).toBe(false);
  });

  it('avisa si hay demasiadas semillas (entra luz)', () => {
    const syntheticFrame = createDarkFrame({ darkLevel: 90, noiseAmplitude: 0 });
    const seedSearch = findSeedPixels(syntheticFrame.pixels, syntheticFrame.layout, 30, noHotPixels, 50);
    expect(seedSearch.isOverflowing).toBe(true);
    expect(seedSearch.seedIndices).toHaveLength(50);
  });
});

describe('agrupación y forma', () => {
  it('junta los píxeles contiguos y separa los sucesos distintos', () => {
    const syntheticFrame = createDarkFrame();
    for (let columnIndex = 10; columnIndex < 14; columnIndex++) syntheticFrame.setBrightness(columnIndex, 10, 150);
    syntheticFrame.setBrightness(40, 40, 120);
    const { seedIndices } = findSeedPixels(syntheticFrame.pixels, syntheticFrame.layout, 30, noHotPixels, 100);
    const clusters = groupSeedsIntoClusters(syntheticFrame.pixels, syntheticFrame.layout, seedIndices, 15, noHotPixels, 100);
    expect(clusters.map((cluster) => cluster.pixelIndices.length).sort()).toEqual([1, 4]);
  });

  it('corta los sucesos enormes (luz, no partículas)', () => {
    const syntheticFrame = createDarkFrame();
    for (let rowIndex = 0; rowIndex < 20; rowIndex++) {
      for (let columnIndex = 0; columnIndex < 20; columnIndex++) syntheticFrame.setBrightness(columnIndex, rowIndex, 200);
    }
    const clusters = groupSeedsIntoClusters(
      syntheticFrame.pixels,
      syntheticFrame.layout,
      [0],
      15,
      noHotPixels,
      50,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.isTruncated).toBe(true);
  });

  it('mide la longitud y la anchura de una traza diagonal', () => {
    const frameWidth = 64;
    const pixelIndices: number[] = [];
    for (let step = 0; step < 12; step++) pixelIndices.push((5 + step) * frameWidth + (8 + step));
    const features = describeCluster(
      { pixelIndices, brightnessValues: pixelIndices.map(() => 100), isTruncated: false },
      frameWidth,
      4,
    );
    expect(features.lengthPixels).toBeCloseTo(11 * Math.SQRT2 + 1, 5);
    expect(features.perpendicularRmsPixels).toBeLessThan(1e-6);
    expect(features.centerX).toBeCloseTo(8 + 5.5, 5);
    expect(features.centerY).toBeCloseTo(5 + 5.5, 5);
    expect(features.totalExcessBrightness).toBe(12 * 96);
    expect(classifyParticleShape(features)).toBe('track');
  });

  it('clasifica punto, gusano y traza', () => {
    expect(classifyParticleShape({ lengthPixels: 2, widthPixels: 2, perpendicularRmsPixels: 0.5 })).toBe('spot');
    expect(classifyParticleShape({ lengthPixels: 9, widthPixels: 2, perpendicularRmsPixels: 0.5 })).toBe('track');
    // Largo pero curvado: se aparta mucho de la recta.
    expect(classifyParticleShape({ lengthPixels: 9, widthPixels: 6, perpendicularRmsPixels: 1.8 })).toBe('worm');
    // Ni punto ni lo bastante largo para traza.
    expect(classifyParticleShape({ lengthPixels: 5, widthPixels: 1, perpendicularRmsPixels: 0.2 })).toBe('worm');
  });

  it('el lado de la miniatura cubre el suceso con margen y queda entre 16 y 64', () => {
    expect(thumbnailSideForCluster({ boundingWidth: 1, boundingHeight: 1 })).toBe(16);
    expect(thumbnailSideForCluster({ boundingWidth: 25, boundingHeight: 3 })).toBe(34);
    expect(thumbnailSideForCluster({ boundingWidth: 200, boundingHeight: 3 })).toBe(64);
  });

  it('la miniatura sale centrada y rellena con 0 fuera del fotograma', () => {
    const syntheticFrame = createDarkFrame({ noiseAmplitude: 0, darkLevel: 2 });
    syntheticFrame.setBrightness(1, 1, 99);
    const thumbnail = copyBrightnessThumbnail(syntheticFrame.pixels, syntheticFrame.layout, 1, 1, 16);
    expect(thumbnail[8 * 16 + 8]).toBe(99);
    expect(thumbnail[0]).toBe(0);
    expect(thumbnail[15 * 16 + 15]).toBe(2);
  });
});

describe('detectParticleEventsInFrame', () => {
  const detectionOptions = { ...defaultParticleDetectionOptions, thresholdOffset: 20 };

  it('encuentra una traza recta, un gusano y un punto e ignora los píxeles calientes', () => {
    const syntheticFrame = createDarkFrame({ frameWidth: 96, frameHeight: 64 });
    // Traza recta de un muón, con algo de anchura como tras el demosaico.
    for (let step = 0; step < 14; step++) {
      syntheticFrame.setBrightness(10 + step * 2, 10 + step, 200);
      syntheticFrame.setBrightness(11 + step * 2, 10 + step, 120);
    }
    // Gusano: un electrón que va cambiando de dirección.
    const wormPath = [
      [60, 40],
      [61, 40],
      [62, 41],
      [62, 42],
      [61, 43],
      [60, 44],
      [60, 45],
      [61, 46],
      [62, 47],
    ] as const;
    for (const [columnIndex, rowIndex] of wormPath) syntheticFrame.setBrightness(columnIndex, rowIndex, 160);
    // Punto aislado.
    syntheticFrame.setBrightness(80, 10, 90);
    // Píxel caliente enmascarado.
    syntheticFrame.setBrightness(5, 55, 255);
    const hotPixelIndices = Int32Array.from([55 * 96 + 5]);

    const detection = detectParticleEventsInFrame(
      syntheticFrame.pixels,
      syntheticFrame.layout,
      hotPixelIndices,
      detectionOptions,
    );
    expect(detection.isLightLeak).toBe(false);
    expect(detection.clusterCount).toBe(3);
    const shapes = detection.events.map((particleEvent) => particleEvent.shape).sort();
    expect(shapes).toEqual(['spot', 'track', 'worm']);
    const trackEvent = detection.events.find((particleEvent) => particleEvent.shape === 'track')!;
    expect(trackEvent.pixelCount).toBe(28);
    expect(trackEvent.thumbnailPixels).toHaveLength(trackEvent.thumbnailSide ** 2);
    const spotEvent = detection.events.find((particleEvent) => particleEvent.shape === 'spot')!;
    expect(spotEvent.peakPixelIndex).toBe(10 * 96 + 80);
  });

  it('un fotograma negro sin partículas no da sucesos', () => {
    const syntheticFrame = createDarkFrame({ noiseAmplitude: 3 });
    const detection = detectParticleEventsInFrame(
      syntheticFrame.pixels,
      syntheticFrame.layout,
      noHotPixels,
      detectionOptions,
    );
    expect(detection.events).toEqual([]);
    expect(detection.darkLevel).toBeGreaterThan(3);
    expect(detection.darkLevel).toBeLessThan(8);
  });

  it('el umbral sigue al nivel de negro: con el sensor más caliente, el mismo exceso se detecta igual', () => {
    const syntheticFrame = createDarkFrame({ darkLevel: 30, noiseAmplitude: 2 });
    syntheticFrame.setBrightness(20, 20, 45);
    syntheticFrame.setBrightness(30, 30, 70);
    const detection = detectParticleEventsInFrame(
      syntheticFrame.pixels,
      syntheticFrame.layout,
      noHotPixels,
      detectionOptions,
    );
    // 45 está a unos 15 niveles del negro (por debajo del umbral); 70, a unos 40.
    expect(detection.events).toHaveLength(1);
    expect(detection.events[0]!.peakPixelIndex).toBe(30 * 64 + 30);
  });

  it('descarta el fotograma si entra luz', () => {
    const syntheticFrame = createDarkFrame({ darkLevel: 120 });
    const detection = detectParticleEventsInFrame(
      syntheticFrame.pixels,
      syntheticFrame.layout,
      noHotPixels,
      detectionOptions,
    );
    expect(detection.isLightLeak).toBe(true);
    expect(detection.events).toEqual([]);
  });
});

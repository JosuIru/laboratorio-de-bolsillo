/**
 * Lectura del brillo para el receptor óptico: la cámara divide el centro de la imagen en una
 * rejilla de casillas y mide el brillo medio de cada una; luego se elige la casilla que más
 * parpadea (la que tiene la linterna o la pantalla del otro móvil).
 */

export type TilePixelLayout = 'rgba' | 'bgra' | 'rgb';

/**
 * Brillo medio (0-255, luma BT.709 aproximada) de cada casilla de una rejilla `gridSize`×`gridSize`
 * que cubre la fracción central `coveredFraction` del fotograma. Salta píxeles (`pixelStep`) para
 * ir rápido. Se ejecuta en el hilo de la cámara.
 */
export function measureTileLuminances(
  pixels: Uint8Array,
  frameWidth: number,
  frameHeight: number,
  bytesPerRow: number,
  pixelLayout: TilePixelLayout,
  gridSize: number,
  coveredFraction: number,
  pixelStep: number,
): number[] {
  'worklet';
  const bytesPerPixel = pixelLayout === 'rgb' ? 3 : 4;
  const redOffset = pixelLayout === 'bgra' ? 2 : 0;
  const blueOffset = pixelLayout === 'bgra' ? 0 : 2;
  const coveredWidth = Math.floor(frameWidth * coveredFraction);
  const coveredHeight = Math.floor(frameHeight * coveredFraction);
  const coveredLeft = Math.floor((frameWidth - coveredWidth) / 2);
  const coveredTop = Math.floor((frameHeight - coveredHeight) / 2);
  const tileLuminances: number[] = [];
  for (let tileRow = 0; tileRow < gridSize; tileRow++) {
    const rowStart = coveredTop + Math.floor((tileRow * coveredHeight) / gridSize);
    const rowEnd = coveredTop + Math.floor(((tileRow + 1) * coveredHeight) / gridSize);
    for (let tileColumn = 0; tileColumn < gridSize; tileColumn++) {
      const columnStart = coveredLeft + Math.floor((tileColumn * coveredWidth) / gridSize);
      const columnEnd = coveredLeft + Math.floor(((tileColumn + 1) * coveredWidth) / gridSize);
      let lumaSum = 0;
      let pixelCount = 0;
      for (let pixelRow = rowStart; pixelRow < rowEnd; pixelRow += pixelStep) {
        const rowOffset = pixelRow * bytesPerRow;
        for (let pixelColumn = columnStart; pixelColumn < columnEnd; pixelColumn += pixelStep) {
          const pixelOffset = rowOffset + pixelColumn * bytesPerPixel;
          lumaSum +=
            54 * pixels[pixelOffset + redOffset]! +
            183 * pixels[pixelOffset + 1]! +
            19 * pixels[pixelOffset + blueOffset]!;
          pixelCount++;
        }
      }
      tileLuminances.push(pixelCount > 0 ? lumaSum / (256 * pixelCount) : 0);
    }
  }
  return tileLuminances;
}

export interface BlinkingTileSelector {
  /** Añade las casillas de un fotograma y devuelve la casilla elegida y su brillo. */
  push(tileLuminances: readonly number[], isSelectionLocked: boolean): { tileIndex: number; luminance: number };
  readonly selectedTileIndex: number;
}

/**
 * Elige la casilla cuyo brillo varía más en los últimos `historyLength` fotogramas. Solo cambia
 * de casilla si la nueva varía claramente más (histéresis) y nunca mientras la selección está
 * bloqueada (durante la recepción de una trama, cambiar de casilla la rompería).
 */
export function createBlinkingTileSelector(tileCount: number, historyLength = 45): BlinkingTileSelector {
  const histories = Array.from({ length: tileCount }, () => [] as number[]);
  let selectedTileIndex = Math.floor(tileCount / 2);

  function varianceOf(values: readonly number[]): number {
    if (values.length < 2) return 0;
    const mean = values.reduce((total, value) => total + value, 0) / values.length;
    return values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  }

  return {
    get selectedTileIndex() {
      return selectedTileIndex;
    },
    push(tileLuminances, isSelectionLocked) {
      for (let tileIndex = 0; tileIndex < tileCount; tileIndex++) {
        const history = histories[tileIndex]!;
        history.push(tileLuminances[tileIndex] ?? 0);
        if (history.length > historyLength) history.shift();
      }
      if (!isSelectionLocked) {
        const variances = histories.map(varianceOf);
        let bestTileIndex = selectedTileIndex;
        for (let tileIndex = 0; tileIndex < tileCount; tileIndex++) {
          if (variances[tileIndex]! > variances[bestTileIndex]!) bestTileIndex = tileIndex;
        }
        if (variances[bestTileIndex]! > 1.5 * variances[selectedTileIndex]!) selectedTileIndex = bestTileIndex;
      }
      return { tileIndex: selectedTileIndex, luminance: tileLuminances[selectedTileIndex] ?? 0 };
    },
  };
}

/**
 * Convierte las marcas de tiempo de los fotogramas a segundos desde el primero. Cada plataforma
 * usa una unidad (Android: nanosegundos); se deduce del salto entre los dos primeros.
 */
export function createFrameTimestampConverter() {
  let firstTimestamp: number | null = null;
  let secondsPerUnit: number | null = null;
  return (rawTimestamp: number): number | null => {
    if (firstTimestamp === null) {
      firstTimestamp = rawTimestamp;
      return 0;
    }
    if (secondsPerUnit === null) {
      const firstInterval = rawTimestamp - firstTimestamp;
      if (firstInterval <= 0) return null;
      if (firstInterval >= 1e6) secondsPerUnit = 1e-9;
      else if (firstInterval >= 1e3) secondsPerUnit = 1e-6;
      else if (firstInterval >= 1) secondsPerUnit = 1e-3;
      else secondsPerUnit = 1;
    }
    return (rawTimestamp - firstTimestamp) * secondsPerUnit;
  };
}

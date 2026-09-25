/**
 * Miniaturas de los sucesos: de brillo (0-255) a RGBA ampliado, con el contraste estirado para
 * que se vea la forma aunque el suceso sea tenue, y un mosaico para guardarlas con la medición.
 *
 * Módulo puro: sin React ni React Native.
 */

export interface BrightnessThumbnail {
  pixels: Uint8Array;
  side: number;
}

export interface RgbaImage {
  rgbaPixels: Uint8Array;
  width: number;
  height: number;
}

/** Paleta «incandescente»: negro → rojo → amarillo → blanco, como una placa de niebla. */
export function glowColor(normalizedLevel: number): [number, number, number] {
  const level = Math.min(1, Math.max(0, normalizedLevel));
  const redValue = Math.round(255 * Math.min(1, level * 2));
  const greenValue = Math.round(255 * Math.min(1, Math.max(0, level * 2 - 0.6)));
  const blueValue = Math.round(255 * Math.max(0, level * 3 - 2));
  return [redValue, greenValue, blueValue];
}

/** Nivel de negro y máximo de la miniatura, para estirar el contraste. */
function brightnessRange(thumbnail: BrightnessThumbnail): { minimumLevel: number; maximumLevel: number } {
  let minimumLevel = 255;
  let maximumLevel = 0;
  for (const brightness of thumbnail.pixels) {
    if (brightness < minimumLevel) minimumLevel = brightness;
    if (brightness > maximumLevel) maximumLevel = brightness;
  }
  return { minimumLevel, maximumLevel };
}

/**
 * Dibuja la miniatura en `target` (RGBA de ancho `targetWidth`) a partir de (`left`, `top`),
 * ampliando cada píxel a un cuadrado de `pixelScale` × `pixelScale`.
 */
function drawThumbnail(
  thumbnail: BrightnessThumbnail,
  pixelScale: number,
  target: Uint8Array,
  targetWidth: number,
  left: number,
  top: number,
): void {
  const { minimumLevel, maximumLevel } = brightnessRange(thumbnail);
  const levelSpan = Math.max(1, maximumLevel - minimumLevel);
  for (let thumbnailRow = 0; thumbnailRow < thumbnail.side; thumbnailRow++) {
    for (let thumbnailColumn = 0; thumbnailColumn < thumbnail.side; thumbnailColumn++) {
      const brightness = thumbnail.pixels[thumbnailRow * thumbnail.side + thumbnailColumn]!;
      // Raíz cuadrada: realza las colas tenues de los gusanos sin quemar el centro.
      const [redValue, greenValue, blueValue] = glowColor(Math.sqrt((brightness - minimumLevel) / levelSpan));
      for (let scaleRow = 0; scaleRow < pixelScale; scaleRow++) {
        const targetRow = top + thumbnailRow * pixelScale + scaleRow;
        for (let scaleColumn = 0; scaleColumn < pixelScale; scaleColumn++) {
          const targetColumn = left + thumbnailColumn * pixelScale + scaleColumn;
          const targetOffset = (targetRow * targetWidth + targetColumn) * 4;
          target[targetOffset] = redValue;
          target[targetOffset + 1] = greenValue;
          target[targetOffset + 2] = blueValue;
          target[targetOffset + 3] = 255;
        }
      }
    }
  }
}

/** La miniatura ampliada a un cuadrado de unos `outputSide` px (múltiplo entero del lado). */
export function renderThumbnailToRgba(thumbnail: BrightnessThumbnail, outputSide: number): RgbaImage {
  const pixelScale = Math.max(1, Math.floor(outputSide / thumbnail.side));
  const side = thumbnail.side * pixelScale;
  const rgbaPixels = new Uint8Array(side * side * 4);
  drawThumbnail(thumbnail, pixelScale, rgbaPixels, side, 0, 0);
  return { rgbaPixels, width: side, height: side };
}

/**
 * Mosaico de miniaturas en casillas de `tileSide` px (cada una centrada y ampliada un número
 * entero de veces), con `gapPixels` de separación negra.
 */
export function buildThumbnailMosaic(
  thumbnails: readonly BrightnessThumbnail[],
  tileSide: number,
  columnCount: number,
  gapPixels: number,
): RgbaImage | null {
  if (thumbnails.length === 0) return null;
  const usedColumnCount = Math.min(columnCount, thumbnails.length);
  const rowCount = Math.ceil(thumbnails.length / usedColumnCount);
  const width = usedColumnCount * tileSide + (usedColumnCount + 1) * gapPixels;
  const height = rowCount * tileSide + (rowCount + 1) * gapPixels;
  const rgbaPixels = new Uint8Array(width * height * 4);
  for (let alphaOffset = 3; alphaOffset < rgbaPixels.length; alphaOffset += 4) rgbaPixels[alphaOffset] = 255;
  thumbnails.forEach((thumbnail, thumbnailIndex) => {
    const tileColumn = thumbnailIndex % usedColumnCount;
    const tileRow = Math.floor(thumbnailIndex / usedColumnCount);
    const pixelScale = Math.max(1, Math.floor(tileSide / thumbnail.side));
    const drawnSide = Math.min(tileSide, thumbnail.side * pixelScale);
    const tileLeft = gapPixels + tileColumn * (tileSide + gapPixels);
    const tileTop = gapPixels + tileRow * (tileSide + gapPixels);
    const centeringMargin = Math.floor((tileSide - drawnSide) / 2);
    drawThumbnail(thumbnail, pixelScale, rgbaPixels, width, tileLeft + centeringMargin, tileTop + centeringMargin);
  });
  return { rgbaPixels, width, height };
}

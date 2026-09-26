import type { ClockwiseRotationDegrees } from '@/processing/image/jpegPhoto';

import {
  centeredSquareCrop,
  clampRectToImage,
  type PixelRect,
  type PixelSize,
  photoRectToViewRect,
  portraitSize,
  rotatedSize,
  rotationStillNeeded,
  scalePointBetweenImages,
  squareCropAround,
  uprightRectToStoredRect,
} from './photoCropGeometry';

/** Imagen de prueba: cada píxel guarda su propio índice, así se sabe de dónde viene. */
interface IndexImage {
  size: PixelSize;
  values: number[];
}

function makeIndexImage(size: PixelSize): IndexImage {
  return { size, values: Array.from({ length: size.width * size.height }, (_value, pixelIndex) => pixelIndex) };
}

/** Giro de referencia, píxel a píxel, en sentido horario. */
function rotateClockwise(image: IndexImage, clockwiseDegrees: ClockwiseRotationDegrees): IndexImage {
  let rotatedImage = image;
  for (let quarterTurn = 0; quarterTurn < clockwiseDegrees / 90; quarterTurn++) {
    const { width, height } = rotatedImage.size;
    const values = new Array<number>(width * height);
    for (let rowIndex = 0; rowIndex < height; rowIndex++) {
      for (let columnIndex = 0; columnIndex < width; columnIndex++) {
        // Un cuarto de vuelta horario: (x, y) → (alto − 1 − y, x) en una imagen de alto × ancho.
        values[columnIndex * height + (height - 1 - rowIndex)] = rotatedImage.values[rowIndex * width + columnIndex]!;
      }
    }
    rotatedImage = { size: { width: height, height: width }, values };
  }
  return rotatedImage;
}

function cropImage(image: IndexImage, rect: PixelRect): IndexImage {
  const values: number[] = [];
  for (let rowIndex = rect.top; rowIndex < rect.top + rect.height; rowIndex++) {
    for (let columnIndex = rect.left; columnIndex < rect.left + rect.width; columnIndex++) {
      values.push(image.values[rowIndex * image.size.width + columnIndex]!);
    }
  }
  return { size: { width: rect.width, height: rect.height }, values };
}

describe('recorte de la foto derecha traducido a la foto guardada', () => {
  const storedImage = makeIndexImage({ width: 8, height: 6 });
  const uprightRect: PixelRect = { left: 1, top: 2, width: 3, height: 2 };

  it.each<ClockwiseRotationDegrees>([0, 90, 180, 270])(
    'con un giro de %i° recortar y girar da lo mismo que girar y recortar',
    (clockwiseDegrees) => {
      const uprightImage = rotateClockwise(storedImage, clockwiseDegrees);
      const expectedCrop = cropImage(uprightImage, uprightRect);
      const storedRect = uprightRectToStoredRect(uprightRect, storedImage.size, clockwiseDegrees);
      const croppedThenRotated = rotateClockwise(cropImage(storedImage, storedRect), clockwiseDegrees);
      expect(croppedThenRotated).toEqual(expectedCrop);
    },
  );
});

describe('tamaños y giros', () => {
  it('90° y 270° intercambian ancho y alto; 0° y 180° no', () => {
    expect(rotatedSize({ width: 4112, height: 3088 }, 90)).toEqual({ width: 3088, height: 4112 });
    expect(rotatedSize({ width: 4112, height: 3088 }, 270)).toEqual({ width: 3088, height: 4112 });
    expect(rotatedSize({ width: 4112, height: 3088 }, 180)).toEqual({ width: 4112, height: 3088 });
  });

  it('la foto derecha de la app es vertical', () => {
    expect(portraitSize({ width: 4112, height: 3088 })).toEqual({ width: 3088, height: 4112 });
    expect(portraitSize({ width: 3088, height: 4112 })).toEqual({ width: 3088, height: 4112 });
  });

  it('si el decodificador ya giró la foto (sale vertical), no se vuelve a girar', () => {
    expect(rotationStillNeeded({ width: 4112, height: 3088 }, 90)).toBe(90);
    expect(rotationStillNeeded({ width: 3088, height: 4112 }, 90)).toBe(0);
    expect(rotationStillNeeded({ width: 3088, height: 4112 }, 270)).toBe(0);
    expect(rotationStillNeeded({ width: 3088, height: 4112 }, 180)).toBe(180);
  });
});

describe('recortes cuadrados', () => {
  const photoSize = { width: 3088, height: 4112 };

  it('el cuadrado centrado queda en el centro de la foto', () => {
    expect(centeredSquareCrop(photoSize, 768)).toEqual({ left: 1160, top: 1672, width: 768, height: 768 });
  });

  it('no puede ser mayor que el lado corto', () => {
    expect(centeredSquareCrop({ width: 500, height: 800 }, 768)).toEqual({ left: 0, top: 150, width: 500, height: 500 });
  });

  it('el cuadrado alrededor de un punto junto al borde se desplaza para no salirse', () => {
    expect(squareCropAround({ x: 10, y: 4100 }, 200, photoSize)).toEqual({ left: 0, top: 3912, width: 200, height: 200 });
    expect(squareCropAround({ x: 1544, y: 2056 }, 200, photoSize)).toEqual({ left: 1444, top: 1956, width: 200, height: 200 });
  });

  it('un rectángulo fuera de la imagen se mete dentro', () => {
    expect(clampRectToImage({ left: -5.4, top: 90, width: 20, height: 20 }, { width: 100, height: 100 })).toEqual({
      left: 0,
      top: 80,
      width: 20,
      height: 20,
    });
  });
});

describe('de una imagen a otra y a la vista previa', () => {
  it('un punto del fotograma de vídeo cae en el mismo sitio relativo de la foto', () => {
    const photoPoint = scalePointBetweenImages({ x: 720, y: 480 }, { width: 1440, height: 1920 }, { width: 3088, height: 4112 });
    expect(photoPoint.x).toBeCloseTo(1544);
    expect(photoPoint.y).toBeCloseTo(1028);
  });

  it('el recorte centrado de la foto se dibuja centrado en la vista, a escala', () => {
    const photoSize = { width: 3000, height: 4000 };
    const viewRect = photoRectToViewRect(centeredSquareCrop(photoSize, 1000), photoSize, { width: 360, height: 340 });
    const displayScale = 340 / 4000;
    expect(viewRect.width).toBeCloseTo(1000 * displayScale);
    expect(viewRect.left + viewRect.width / 2).toBeCloseTo(180);
    expect(viewRect.top + viewRect.height / 2).toBeCloseTo(170);
  });
});

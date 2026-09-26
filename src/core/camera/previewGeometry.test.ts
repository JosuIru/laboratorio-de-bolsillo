import { centeredFrameSquareInView, containedFrameRect, convertCameraPointsToViewPoints } from './previewGeometry';

describe('imagen de la cámara en una vista «contain»', () => {
  it('un fotograma 4:3 en la vista normal (360 × 340) queda limitado por el alto', () => {
    const frameRect = containedFrameRect({ viewWidth: 360, viewHeight: 340, frameWidth: 1600, frameHeight: 1200 });
    expect(frameRect.displayScale).toBeCloseTo(340 / 1200);
    expect(frameRect.height).toBeCloseTo(340);
    expect(frameRect.top).toBeCloseTo(0);
    expect(frameRect.left).toBeCloseTo((360 - 1600 * (340 / 1200)) / 2);
  });

  it('a pantalla completa (360 × 780) queda limitado por el ancho y centrado en vertical', () => {
    const frameRect = containedFrameRect({ viewWidth: 360, viewHeight: 780, frameWidth: 1600, frameHeight: 1200 });
    expect(frameRect.width).toBeCloseTo(360);
    expect(frameRect.left).toBeCloseTo(0);
    expect(frameRect.top).toBeCloseTo((780 - 270) / 2);
  });
});

describe('recuadro de recorte centrado', () => {
  it('abarca la misma fracción del fotograma a cualquier tamaño de vista', () => {
    const frameSize = { frameWidth: 1600, frameHeight: 1200, squareSidePixels: 768 };
    const normalCropRect = centeredFrameSquareInView({ viewWidth: 360, viewHeight: 340, ...frameSize });
    const fullScreenCropRect = centeredFrameSquareInView({ viewWidth: 360, viewHeight: 780, ...frameSize });
    const normalImageWidth = containedFrameRect({ viewWidth: 360, viewHeight: 340, ...frameSize }).width;
    const fullScreenImageWidth = containedFrameRect({ viewWidth: 360, viewHeight: 780, ...frameSize }).width;
    expect(normalCropRect.width / normalImageWidth).toBeCloseTo(768 / 1600);
    expect(fullScreenCropRect.width / fullScreenImageWidth).toBeCloseTo(768 / 1600);
    // Centrado en la vista.
    expect(fullScreenCropRect.left + fullScreenCropRect.width / 2).toBeCloseTo(180);
    expect(fullScreenCropRect.top + fullScreenCropRect.height / 2).toBeCloseTo(390);
  });
});

describe('conversión de puntos de cámara a la vista', () => {
  // Conversor de prueba: cámara normalizada 0–1 sobre una vista de 360 × 780.
  const convertToFullScreenView = (cameraPoint: { x: number; y: number }) => ({
    x: cameraPoint.x * 360,
    y: cameraPoint.y * 780,
  });

  it('respeta los huecos sin colocar y convierte el resto', () => {
    expect(convertCameraPointsToViewPoints([{ x: 0.5, y: 0.5 }, null], convertToFullScreenView)).toEqual([
      { x: 180, y: 390 },
      null,
    ]);
  });

  it('si la vista previa aún no está lista (el conversor lanza), el punto queda sin situar', () => {
    const failingConverter = () => {
      throw new Error('PreviewView no está lista');
    };
    expect(convertCameraPointsToViewPoints([{ x: 0.5, y: 0.5 }], failingConverter)).toEqual([null]);
  });

  it('descarta resultados no finitos', () => {
    expect(convertCameraPointsToViewPoints([{ x: 0.5, y: 0.5 }], () => ({ x: Number.NaN, y: 1 }))).toEqual([null]);
  });
});

import {
  clampScale,
  clampTranslation,
  computeDoubleTapTransform,
  computePinchTransform,
  detectSwipe,
  distanceBetween,
  doubleTapZoomScale,
  identityTransform,
  maximumZoomScale,
  midpointBetween,
  nextImageIndex,
} from './imageViewerGeometry';

const viewport = { width: 400, height: 800 };

describe('geometría del visor de imágenes', () => {
  it('distancia y punto medio entre dos dedos', () => {
    expect(distanceBetween({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(midpointBetween({ x: 0, y: 10 }, { x: 20, y: 30 })).toEqual({ x: 10, y: 20 });
  });

  it('limita la escala entre 1 y el máximo', () => {
    expect(clampScale(0.3)).toBe(1);
    expect(clampScale(2)).toBe(2);
    expect(clampScale(50)).toBe(maximumZoomScale);
  });

  it('sin zoom no se puede desplazar; con zoom, hasta el borde', () => {
    expect(clampTranslation({ x: 50, y: -50 }, 1, viewport)).toEqual({ x: 0, y: 0 });
    expect(clampTranslation({ x: 500, y: -900 }, 2, viewport)).toEqual({ x: 200, y: -400 });
    expect(clampTranslation({ x: 10, y: 20 }, 2, viewport)).toEqual({ x: 10, y: 20 });
  });

  it('pellizcar en el centro amplía sin desplazar', () => {
    const pinchTransform = computePinchTransform({
      startTransform: identityTransform,
      startDistance: 100,
      startFocalPoint: { x: 200, y: 400 },
      currentDistance: 200,
      currentFocalPoint: { x: 200, y: 400 },
      viewport,
    });
    expect(pinchTransform.scale).toBe(2);
    expect(pinchTransform.translation.x).toBeCloseTo(0);
    expect(pinchTransform.translation.y).toBeCloseTo(0);
  });

  it('pellizcar fuera del centro mantiene ese punto bajo los dedos', () => {
    const pinchTransform = computePinchTransform({
      startTransform: identityTransform,
      startDistance: 100,
      startFocalPoint: { x: 300, y: 400 },
      currentDistance: 200,
      currentFocalPoint: { x: 300, y: 400 },
      viewport,
    });
    // El punto x=300 está 100 px a la derecha del centro; con escala 2 quedaría a 200 px,
    // así que la imagen se desplaza 100 px a la izquierda.
    expect(pinchTransform.translation.x).toBeCloseTo(-100);
  });

  it('al pellizcar hacia dentro no baja de escala 1 y vuelve al centro', () => {
    const pinchTransform = computePinchTransform({
      startTransform: { scale: 2, translation: { x: 150, y: 0 } },
      startDistance: 200,
      startFocalPoint: { x: 200, y: 400 },
      currentDistance: 20,
      currentFocalPoint: { x: 200, y: 400 },
      viewport,
    });
    expect(pinchTransform).toEqual({ scale: 1, translation: { x: 0, y: 0 } });
  });

  it('el doble toque alterna entre ampliar y el tamaño original', () => {
    const zoomedTransform = computeDoubleTapTransform(identityTransform, { x: 200, y: 400 }, viewport);
    expect(zoomedTransform.scale).toBe(doubleTapZoomScale);
    expect(zoomedTransform.translation.x).toBeCloseTo(0);
    expect(computeDoubleTapTransform(zoomedTransform, { x: 10, y: 10 }, viewport)).toEqual(identityTransform);
  });

  it('detecta el deslizamiento horizontal para pasar de imagen', () => {
    expect(detectSwipe(-120, 10, 0.1, 400)).toBe('next');
    expect(detectSwipe(120, 10, 0.1, 400)).toBe('previous');
    expect(detectSwipe(-30, 5, 1.2, 400)).toBe('next');
    expect(detectSwipe(-30, 5, 0.1, 400)).toBe('none');
    expect(detectSwipe(-120, 200, 0.1, 400)).toBe('none');
  });

  it('no se sale de la lista al pasar de imagen', () => {
    expect(nextImageIndex(0, 'previous', 3)).toBe(0);
    expect(nextImageIndex(2, 'next', 3)).toBe(2);
    expect(nextImageIndex(1, 'next', 3)).toBe(2);
    expect(nextImageIndex(1, 'none', 3)).toBe(1);
  });
});

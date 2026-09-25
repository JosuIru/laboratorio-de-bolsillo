/**
 * Mock mínimo de @shopify/react-native-skia para Jest: los tests no dibujan, solo necesitan
 * que los módulos que usan Skia se puedan importar y renderizar sin el motor nativo.
 */
import type { ReactNode } from 'react';

function createFakePath() {
  const fakePath = {
    moveTo: () => fakePath,
    lineTo: () => fakePath,
    close: () => fakePath,
    reset: () => fakePath,
    rewind: () => fakePath,
  };
  return fakePath;
}

export const Skia = {
  Path: { Make: createFakePath },
  Data: { fromBytes: (bytes: Uint8Array) => ({ bytes }) },
  Image: { MakeImage: () => ({ width: () => 0, height: () => 0, dispose: () => undefined }) },
};
export const AlphaType = { Unknown: 0, Opaque: 1, Premul: 2, Unpremul: 3 };
export const ColorType = { RGBA_8888: 4 };
export const Image = () => null;
export const vec = (x = 0, y = 0) => ({ x, y });
export const Canvas = ({ children }: { children?: ReactNode }) => children ?? null;
export const Path = () => null;
export const Line = () => null;
export const Rect = () => null;
export const Group = ({ children }: { children?: ReactNode }) => children ?? null;

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

export const Skia = { Path: { Make: createFakePath } };
export const vec = (x = 0, y = 0) => ({ x, y });
export const Canvas = ({ children }: { children?: ReactNode }) => children ?? null;
export const Path = () => null;
export const Line = () => null;
export const Rect = () => null;
export const Group = ({ children }: { children?: ReactNode }) => children ?? null;

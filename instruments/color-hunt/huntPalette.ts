import { deltaE2000 } from '@/processing/color/colorDifference';
import { hexToRgb8, type Lab, srgbToLab } from '@/processing/color/colorSpaces';

/**
 * Un color de la paleta del juego. Los de `isTarget` son colores objetivo: tonos que se
 * encuentran en objetos cotidianos (fruta, ropa, libros, plantas…), sin saturaciones extremas
 * que una cámara de móvil no puede captar. Los demás solo sirven para nombrar lo que se ve.
 */
export interface HuntPaletteColor {
  /** Estable: es la clave i18n `palette.<id>`. */
  id: string;
  hexColor: string;
  isTarget: boolean;
}

export interface HuntPaletteColorWithLab extends HuntPaletteColor {
  lab: Lab;
}

const paletteDefinitions: readonly HuntPaletteColor[] = [
  { id: 'tomatoRed', hexColor: '#C8372D', isTarget: true },
  { id: 'burgundy', hexColor: '#7B2233', isTarget: true },
  { id: 'terracotta', hexColor: '#B8603E', isTarget: true },
  { id: 'orange', hexColor: '#E07B24', isTarget: true },
  { id: 'mustard', hexColor: '#C9A227', isTarget: true },
  { id: 'lemonYellow', hexColor: '#E8D44D', isTarget: true },
  { id: 'limeGreen', hexColor: '#8DBF3A', isTarget: true },
  { id: 'leafGreen', hexColor: '#3F7F3A', isTarget: true },
  { id: 'oliveGreen', hexColor: '#6B6B2E', isTarget: true },
  { id: 'mintGreen', hexColor: '#8FD1B0', isTarget: true },
  { id: 'turquoise', hexColor: '#1F8A8A', isTarget: true },
  { id: 'skyBlue', hexColor: '#6FA8DC', isTarget: true },
  { id: 'denimBlue', hexColor: '#3B5B8C', isTarget: true },
  { id: 'navyBlue', hexColor: '#1F2A4D', isTarget: true },
  { id: 'lavender', hexColor: '#A79AD1', isTarget: true },
  { id: 'purple', hexColor: '#6A3D8F', isTarget: true },
  { id: 'pink', hexColor: '#E08AAE', isTarget: true },
  { id: 'salmon', hexColor: '#F08C73', isTarget: true },
  { id: 'chocolateBrown', hexColor: '#5C3A24', isTarget: true },
  { id: 'sandBeige', hexColor: '#D8C39A', isTarget: true },
  { id: 'pearlGray', hexColor: '#B9BCC0', isTarget: true },
  { id: 'white', hexColor: '#F2F2F2', isTarget: false },
  { id: 'charcoalGray', hexColor: '#4A4B4F', isTarget: false },
  { id: 'black', hexColor: '#1C1C1C', isTarget: false },
];

export const huntPalette: readonly HuntPaletteColorWithLab[] = paletteDefinitions.map((paletteColor) => ({
  ...paletteColor,
  lab: srgbToLab(hexToRgb8(paletteColor.hexColor)!),
}));

export const huntTargetColors: readonly HuntPaletteColorWithLab[] = huntPalette.filter(
  (paletteColor) => paletteColor.isTarget,
);

export function findPaletteColor(colorId: string): HuntPaletteColorWithLab | undefined {
  return huntPalette.find((paletteColor) => paletteColor.id === colorId);
}

/** El color de la paleta (objetivo o no) más parecido, para dar un nombre aproximado. */
export function nearestPaletteColor(sampleLab: Lab): { paletteColor: HuntPaletteColorWithLab; deltaE: number } {
  let nearestColor = huntPalette[0]!;
  let nearestDeltaE = Number.POSITIVE_INFINITY;
  for (const paletteColor of huntPalette) {
    const candidateDeltaE = deltaE2000(sampleLab, paletteColor.lab);
    if (candidateDeltaE < nearestDeltaE) {
      nearestColor = paletteColor;
      nearestDeltaE = candidateDeltaE;
    }
  }
  return { paletteColor: nearestColor, deltaE: nearestDeltaE };
}

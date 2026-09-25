/**
 * Proyección polar del cielo (skyplot): el centro es el cénit, el borde el horizonte,
 * el norte arriba y el este a la derecha, que es la convención de los receptores GNSS
 * (como un mapa, no como el cielo visto tumbado boca arriba, que tendría el este a la izquierda).
 */

export interface PlotPoint {
  x: number;
  y: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Distancia al centro proporcional a (90° − elevación): proyección equidistante azimutal.
 * Las elevaciones negativas (satélites bajo el horizonte que algún chip informa) se pegan al borde.
 */
export function projectSkyPosition(
  elevationDegrees: number,
  azimuthDegrees: number,
  centerX: number,
  centerY: number,
  horizonRadius: number,
): PlotPoint {
  const zenithDistanceFraction = (90 - clamp(elevationDegrees, 0, 90)) / 90;
  const radialDistance = zenithDistanceFraction * horizonRadius;
  const azimuthRadians = (azimuthDegrees * Math.PI) / 180;
  return {
    x: centerX + radialDistance * Math.sin(azimuthRadians),
    y: centerY - radialDistance * Math.cos(azimuthRadians),
  };
}

/** Radio del círculo de una elevación dada (para dibujar los anillos de 30° y 60°). */
export function elevationRingRadius(elevationDegrees: number, horizonRadius: number): number {
  return ((90 - clamp(elevationDegrees, 0, 90)) / 90) * horizonRadius;
}

/**
 * Calidad de la señal de 0 (sin señal, ≤ 10 dB-Hz) a 1 (excelente, ≥ 45 dB-Hz).
 * En móviles, 20 dB-Hz es apenas usable y 40 dB-Hz es muy buena.
 */
export function carrierToNoiseQuality(carrierToNoiseDensityDbHz: number): number {
  return clamp((carrierToNoiseDensityDbHz - 10) / 35, 0, 1);
}

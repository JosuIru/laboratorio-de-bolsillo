import { julianDayFromDate } from '@/processing/astronomy/moonEphemeris';
import { computeLunarOrientation } from '@/processing/astronomy/lunarOrientation';
import type { LunarDiskView } from '@/processing/astronomy/lunarFeatures';

import {
  atlasDisplayThresholds,
  atlasLanguageFor,
  chooseAtlasMarks,
  computeAtlasOrientation,
  deviceRollFromUpwardAcceleration,
  grayImageFromFloatRgb,
} from './moonAtlas';

const frontalView: LunarDiskView = {
  centerX: 100,
  centerY: 100,
  radiusPixels: 90,
  librationLongitudeDegrees: 0,
  librationLatitudeDegrees: 0,
  northAngleDegrees: 0,
};

describe('deviceRollFromUpwardAcceleration', () => {
  it('vale 0 con el móvil vertical y 90 girado un cuarto de vuelta en sentido antihorario', () => {
    expect(deviceRollFromUpwardAcceleration({ x: 0, y: 9.8, z: 0 })).toBeCloseTo(0, 6);
    // Girado a la izquierda, la vertical del mundo apunta hacia el lado derecho del móvil.
    expect(deviceRollFromUpwardAcceleration({ x: 9.8, y: 0, z: 0 })).toBeCloseTo(90, 6);
    expect(deviceRollFromUpwardAcceleration({ x: -4.9, y: 4.9, z: 7 })).toBeCloseTo(-45, 6);
  });

  it('no da giro si la cámara mira casi al cenit', () => {
    expect(deviceRollFromUpwardAcceleration({ x: 0.5, y: 0.5, z: -9.7 })).toBeNull();
  });
});

describe('computeAtlasOrientation', () => {
  const julianDay = julianDayFromDate(new Date('2026-09-20T21:00:00Z'));
  const disk = { centerX: 150, centerY: 140, radius: 120 };

  it('sin ubicación solo usa P (y la óptica) y avisa de que es aproximada', () => {
    const orientation = computeAtlasOrientation({
      julianDay,
      observerLocation: null,
      deviceRollDegrees: 30,
      correction: { opticsRotationDegrees: 0, isMirrored: false },
      disk,
    });
    expect(orientation.isApproximate).toBe(true);
    expect(orientation.view.northAngleDegrees).toBeCloseTo(computeLunarOrientation(julianDay).axisPositionAngleDegrees, 6);
    expect(orientation.view.centerX).toBe(150);
    expect(orientation.view.radiusPixels).toBe(120);
  });

  it('la corrección de 180° da la vuelta al norte y el espejo pasa a la vista', () => {
    const baseInputs = {
      julianDay,
      observerLocation: { latitudeDegrees: 43.3, longitudeDegrees: -2 },
      deviceRollDegrees: 10,
      disk,
    };
    const upright = computeAtlasOrientation({ ...baseInputs, correction: { opticsRotationDegrees: 0, isMirrored: false } });
    const rotated = computeAtlasOrientation({ ...baseInputs, correction: { opticsRotationDegrees: 180, isMirrored: true } });
    expect(upright.isApproximate).toBe(false);
    const angleDifference = (((rotated.view.northAngleDegrees - upright.view.northAngleDegrees) % 360) + 360) % 360;
    expect(angleDifference).toBeCloseTo(180, 6);
    expect(rotated.view.isMirroredHorizontally).toBe(true);
  });

  it('con ubicación, girar el móvil gira el norte en sentido contrario', () => {
    const baseInputs = {
      julianDay,
      observerLocation: { latitudeDegrees: 43.3, longitudeDegrees: -2 },
      correction: { opticsRotationDegrees: 0 as const, isMirrored: false },
      disk,
    };
    const level = computeAtlasOrientation({ ...baseInputs, deviceRollDegrees: 0 });
    const tilted = computeAtlasOrientation({ ...baseInputs, deviceRollDegrees: 20 });
    const angleDifference = (((level.view.northAngleDegrees - tilted.view.northAngleDegrees) % 360) + 360) % 360;
    expect(angleDifference).toBeCloseTo(20, 6);
  });
});

describe('chooseAtlasMarks', () => {
  it('en un disco muy pequeño no pone nada', () => {
    expect(chooseAtlasMarks(frontalView, 0.3, 'es')).toEqual([]);
  });

  it('en un disco mediano pone los mares con nombre y los Apolo sin nombre, sin cráteres', () => {
    const displayScale = 60 / frontalView.radiusPixels;
    const atlasMarks = chooseAtlasMarks(frontalView, displayScale, 'es');
    expect(atlasMarks.some((atlasMark) => atlasMark.kind === 'crater')).toBe(false);
    const imbrium = atlasMarks.find((atlasMark) => atlasMark.featureId === 'mare-imbrium');
    expect(imbrium?.label).toBe('Mar de las Lluvias');
    const apollo11 = atlasMarks.find((atlasMark) => atlasMark.featureId === 'apollo-11');
    expect(apollo11?.label).toBeNull();
  });

  it('en un disco grande nombra los cráteres en euskera y los coloca a escala', () => {
    const displayScale = 2;
    const atlasMarks = chooseAtlasMarks(frontalView, displayScale, 'eu');
    expect(frontalView.radiusPixels * displayScale).toBeGreaterThan(atlasDisplayThresholds.craterLabels);
    const copernicus = atlasMarks.find((atlasMark) => atlasMark.featureId === 'copernicus');
    expect(copernicus?.label).toBe('Koperniko');
    // Copérnico está al oeste (izquierda con el norte arriba) y algo al norte del centro.
    expect(copernicus!.displayX).toBeLessThan(100 * displayScale);
    expect(copernicus!.displayY).toBeLessThan(100 * displayScale);
    expect(copernicus!.markRadius).toBeGreaterThan(3);
  });

  it('descarta lo que queda en la cara oculta', () => {
    // Con una libración exagerada de 80° hacia el Mare Crisium, el Océano de las Tormentas queda detrás.
    const turnedView = { ...frontalView, librationLongitudeDegrees: 80 };
    const atlasMarks = chooseAtlasMarks(turnedView, 2, 'es');
    expect(atlasMarks.some((atlasMark) => atlasMark.featureId === 'oceanus-procellarum')).toBe(false);
    expect(atlasMarks.some((atlasMark) => atlasMark.featureId === 'mare-crisium')).toBe(true);
  });

  it('marca como no iluminado lo que queda al otro lado del terminador', () => {
    // Sol sobre el meridiano 90° este: el lado oeste (izquierda) está de noche.
    const litView = { ...frontalView, subsolarPoint: { latitudeDegrees: 0, longitudeDegrees: 90 } };
    const atlasMarks = chooseAtlasMarks(litView, 2, 'es');
    expect(atlasMarks.find((atlasMark) => atlasMark.featureId === 'kepler')?.isIlluminated).toBe(false);
    expect(atlasMarks.find((atlasMark) => atlasMark.featureId === 'langrenus')?.isIlluminated).toBe(true);
  });
});

describe('atlasLanguageFor', () => {
  it('usa euskera solo si el idioma de la app es euskera', () => {
    expect(atlasLanguageFor('eu')).toBe('eu');
    expect(atlasLanguageFor('eu-ES')).toBe('eu');
    expect(atlasLanguageFor('es')).toBe('es');
    expect(atlasLanguageFor(undefined)).toBe('es');
  });
});

describe('grayImageFromFloatRgb', () => {
  it('calcula la luminancia de cada píxel', () => {
    const grayImage = grayImageFromFloatRgb({ size: 1, channels: Float32Array.from([100, 200, 50]) });
    expect(grayImage.values[0]).toBeCloseTo(0.299 * 100 + 0.587 * 200 + 0.114 * 50, 3);
  });
});

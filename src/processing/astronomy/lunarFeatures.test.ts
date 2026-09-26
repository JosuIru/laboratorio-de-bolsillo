import { type LunarDiskView, lunarFeatures, projectLunarFeatures, projectSelenographicPoint } from './lunarFeatures';

const baseView: LunarDiskView = {
  centerX: 200,
  centerY: 150,
  radiusPixels: 100,
  librationLongitudeDegrees: -1.2,
  librationLatitudeDegrees: 4.2,
  northAngleDegrees: 0,
};

describe('lunarFeatures', () => {
  it('tiene unos 40 elementos con identificadores únicos y coordenadas válidas', () => {
    expect(lunarFeatures.length).toBeGreaterThanOrEqual(38);
    expect(new Set(lunarFeatures.map((lunarFeature) => lunarFeature.id)).size).toBe(lunarFeatures.length);
    for (const lunarFeature of lunarFeatures) {
      expect(Math.abs(lunarFeature.latitudeDegrees)).toBeLessThanOrEqual(90);
      expect(Math.abs(lunarFeature.longitudeDegrees)).toBeLessThanOrEqual(180);
      expect(lunarFeature.names.es.length).toBeGreaterThan(0);
      expect(lunarFeature.names.eu.length).toBeGreaterThan(0);
    }
    expect(lunarFeatures.filter((lunarFeature) => lunarFeature.kind === 'landingSite')).toHaveLength(6);
  });

  it('sin libración ni giro, todo el catálogo está en la cara visible', () => {
    const projected = projectLunarFeatures({ ...baseView, librationLongitudeDegrees: 0, librationLatitudeDegrees: 0 });
    expect(projected.every((projectedFeature) => projectedFeature.isOnVisibleSide)).toBe(true);
  });
});

describe('projectSelenographicPoint', () => {
  it('el punto de la libración cae en el centro del disco', () => {
    const projected = projectSelenographicPoint({ latitudeDegrees: 4.2, longitudeDegrees: -1.2 }, { ...baseView, northAngleDegrees: 37 });
    expect(projected.imageX).toBeCloseTo(200, 6);
    expect(projected.imageY).toBeCloseTo(150, 6);
    expect(projected.isOnVisibleSide).toBe(true);
  });

  it('un punto a 90° del centro cae en el limbo, y el opuesto en la cara oculta', () => {
    const limbPoint = projectSelenographicPoint({ latitudeDegrees: -85.8, longitudeDegrees: -1.2 }, baseView);
    expect(Math.hypot(limbPoint.imageX - 200, limbPoint.imageY - 150)).toBeCloseTo(100, 4);
    const farSidePoint = projectSelenographicPoint({ latitudeDegrees: -4.2, longitudeDegrees: 178.8 }, baseView);
    expect(farSidePoint.isOnVisibleSide).toBe(false);
  });

  it('con el norte arriba, el Mare Crisium queda a la derecha y Tycho abajo', () => {
    const projected = projectLunarFeatures(baseView);
    const crisium = projected.find((projectedFeature) => projectedFeature.feature.id === 'mare-crisium')!;
    const tycho = projected.find((projectedFeature) => projectedFeature.feature.id === 'tycho')!;
    const plato = projected.find((projectedFeature) => projectedFeature.feature.id === 'plato')!;
    expect(crisium.imageX).toBeGreaterThan(250);
    expect(tycho.imageY).toBeGreaterThan(200);
    expect(plato.imageY).toBeLessThan(100);
  });

  it('es simétrica: longitudes opuestas se reflejan en el eje vertical y girar 180° invierte todo', () => {
    const neutralView = { ...baseView, librationLongitudeDegrees: 0, librationLatitudeDegrees: 0 };
    const eastPoint = projectSelenographicPoint({ latitudeDegrees: 20, longitudeDegrees: 35 }, neutralView);
    const westPoint = projectSelenographicPoint({ latitudeDegrees: 20, longitudeDegrees: -35 }, neutralView);
    expect(eastPoint.imageX - 200).toBeCloseTo(200 - westPoint.imageX, 6);
    expect(eastPoint.imageY).toBeCloseTo(westPoint.imageY, 6);

    const rotatedPoint = projectSelenographicPoint({ latitudeDegrees: 20, longitudeDegrees: 35 }, { ...neutralView, northAngleDegrees: 180 });
    expect(rotatedPoint.imageX - 200).toBeCloseTo(200 - eastPoint.imageX, 6);
    expect(rotatedPoint.imageY - 150).toBeCloseTo(150 - eastPoint.imageY, 6);

    const mirroredPoint = projectSelenographicPoint({ latitudeDegrees: 20, longitudeDegrees: 35 }, { ...neutralView, isMirroredHorizontally: true });
    expect(mirroredPoint.imageX).toBeCloseTo(westPoint.imageX, 6);
  });

  it('girar el norte 90° antihorario lleva el polo norte a la izquierda', () => {
    const northPole = projectSelenographicPoint(
      { latitudeDegrees: 90, longitudeDegrees: 0 },
      { ...baseView, librationLatitudeDegrees: 0, librationLongitudeDegrees: 0, northAngleDegrees: 90 },
    );
    expect(northPole.imageX).toBeCloseTo(100, 6);
    expect(northPole.imageY).toBeCloseTo(150, 6);
  });

  it('marca como iluminado solo el lado del Sol (cuarto creciente: el Sol en longitud +90°)', () => {
    const waxingQuarterView = { ...baseView, subsolarPoint: { latitudeDegrees: 0, longitudeDegrees: 90 } };
    const projected = projectLunarFeatures(waxingQuarterView);
    const crisium = projected.find((projectedFeature) => projectedFeature.feature.id === 'mare-crisium')!;
    const copernicus = projected.find((projectedFeature) => projectedFeature.feature.id === 'copernicus')!;
    expect(crisium.isIlluminated).toBe(true);
    expect(crisium.sunAltitudeDegrees).toBeGreaterThan(20);
    expect(copernicus.isIlluminated).toBe(false);
    // Los accidentes cerca del meridiano central tienen el Sol rasante.
    const ptolemaeus = projected.find((projectedFeature) => projectedFeature.feature.id === 'ptolemaeus')!;
    expect(Math.abs(ptolemaeus.sunAltitudeDegrees)).toBeLessThan(3);
  });

  it('da el radio aparente en píxeles a partir del diámetro', () => {
    const tycho = projectLunarFeatures(baseView).find((projectedFeature) => projectedFeature.feature.id === 'tycho')!;
    expect(tycho.apparentRadiusPixels).toBeCloseTo((85 / 2 / 1737.4) * 100, 6);
  });
});

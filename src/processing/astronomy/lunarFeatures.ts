/**
 * Catálogo breve de accidentes lunares y su proyección sobre la foto del disco.
 *
 * Coordenadas y diámetros: «Gazetteer of Planetary Nomenclature» de la IAU y el USGS
 * (https://planetarynames.wr.usgs.gov/, dominio público), redondeados a 0,1°. Lugares de
 * alunizaje: coordenadas publicadas por la NASA (dominio público). Longitud positiva hacia el
 * este IAU (el lado del Mare Crisium, a la derecha con el norte lunar arriba).
 *
 * Los nombres en castellano siguen el uso habitual; en euskera, cuando no hay uno asentado, se
 * traduce el de los mares y se deja el latino (o su grafía vasca) en los cráteres.
 *
 * Módulo puro: sin React ni React Native.
 */

import type { SelenographicPoint } from './lunarOrientation';

export type LunarFeatureKind = 'mare' | 'crater' | 'landingSite';

export interface LunarFeature {
  /** Identificador estable, en minúsculas y sin espacios. */
  id: string;
  /** Nombre oficial (IAU) en latín o el de la misión. */
  officialName: string;
  names: { es: string; eu: string };
  kind: LunarFeatureKind;
  latitudeDegrees: number;
  longitudeDegrees: number;
  /** Diámetro (en los lugares de alunizaje, 0). */
  diameterKilometers: number;
}

function feature(
  id: string,
  officialName: string,
  spanishName: string,
  basqueName: string,
  kind: LunarFeatureKind,
  latitudeDegrees: number,
  longitudeDegrees: number,
  diameterKilometers: number,
): LunarFeature {
  return {
    id,
    officialName,
    names: { es: spanishName, eu: basqueName },
    kind,
    latitudeDegrees,
    longitudeDegrees,
    diameterKilometers,
  };
}

export const lunarFeatures: readonly LunarFeature[] = [
  // Mares (y un océano, una bahía y un «seno»), visibles a simple vista.
  feature('mare-imbrium', 'Mare Imbrium', 'Mar de las Lluvias', 'Euriteen itsasoa', 'mare', 32.8, -15.6, 1146),
  feature('mare-serenitatis', 'Mare Serenitatis', 'Mar de la Serenidad', 'Baretasunaren itsasoa', 'mare', 28.0, 17.5, 707),
  feature('mare-tranquillitatis', 'Mare Tranquillitatis', 'Mar de la Tranquilidad', 'Lasaitasunaren itsasoa', 'mare', 8.5, 31.4, 873),
  feature('mare-crisium', 'Mare Crisium', 'Mar de las Crisis', 'Krisien itsasoa', 'mare', 17.0, 59.1, 556),
  feature('mare-fecunditatis', 'Mare Fecunditatis', 'Mar de la Fecundidad', 'Emankortasunaren itsasoa', 'mare', -7.8, 51.3, 909),
  feature('mare-nectaris', 'Mare Nectaris', 'Mar del Néctar', 'Nektarraren itsasoa', 'mare', -15.2, 35.5, 333),
  feature('mare-nubium', 'Mare Nubium', 'Mar de las Nubes', 'Hodeien itsasoa', 'mare', -21.3, -16.6, 715),
  feature('mare-humorum', 'Mare Humorum', 'Mar de los Humores', 'Hezetasunaren itsasoa', 'mare', -24.4, -38.6, 389),
  feature('mare-frigoris', 'Mare Frigoris', 'Mar del Frío', 'Hotzaren itsasoa', 'mare', 56.0, 1.4, 1596),
  feature('mare-vaporum', 'Mare Vaporum', 'Mar de los Vapores', 'Lurrunen itsasoa', 'mare', 13.3, 3.6, 245),
  feature('mare-cognitum', 'Mare Cognitum', 'Mar Conocido', 'Itsaso Ezaguna', 'mare', -10.0, -23.1, 376),
  feature('mare-insularum', 'Mare Insularum', 'Mar de las Islas', 'Uharteen itsasoa', 'mare', 7.5, -30.9, 513),
  feature('oceanus-procellarum', 'Oceanus Procellarum', 'Océano de las Tormentas', 'Ekaitzen ozeanoa', 'mare', 18.4, -57.4, 2568),
  feature('sinus-iridum', 'Sinus Iridum', 'Bahía del Arco Iris', 'Ostadarraren badia', 'mare', 44.1, -31.5, 236),
  feature('sinus-medii', 'Sinus Medii', 'Bahía Central', 'Erdiko badia', 'mare', 2.4, 1.7, 335),

  // Cráteres que se distinguen con unos prismáticos o un telescopio pequeño.
  feature('tycho', 'Tycho', 'Tycho', 'Tycho', 'crater', -43.3, -11.4, 85),
  feature('copernicus', 'Copernicus', 'Copérnico', 'Koperniko', 'crater', 9.6, -20.1, 96),
  feature('kepler', 'Kepler', 'Kepler', 'Kepler', 'crater', 8.1, -38.0, 31),
  feature('aristarchus', 'Aristarchus', 'Aristarco', 'Aristarko', 'crater', 23.7, -47.5, 40),
  feature('plato', 'Plato', 'Platón', 'Platon', 'crater', 51.6, -9.4, 101),
  feature('clavius', 'Clavius', 'Clavius', 'Clavius', 'crater', -58.4, -14.4, 231),
  feature('plinius', 'Plinius', 'Plinio', 'Plinio', 'crater', 15.4, 23.6, 43),
  feature('theophilus', 'Theophilus', 'Teófilo', 'Teofilo', 'crater', -11.4, 26.4, 99),
  feature('cyrillus', 'Cyrillus', 'Cirilo', 'Ziriloa', 'crater', -13.2, 24.0, 98),
  feature('catharina', 'Catharina', 'Catalina', 'Katalina', 'crater', -18.1, 23.6, 99),
  feature('ptolemaeus', 'Ptolemaeus', 'Ptolomeo', 'Ptolomeo', 'crater', -9.3, -1.9, 154),
  feature('alphonsus', 'Alphonsus', 'Alfonso', 'Alfontso', 'crater', -13.4, -3.2, 108),
  feature('arzachel', 'Arzachel', 'Azarquiel', 'Azarkiel', 'crater', -18.2, -1.9, 97),
  feature('archimedes', 'Archimedes', 'Arquímedes', 'Arkimedes', 'crater', 29.7, -4.0, 81),
  feature('eratosthenes', 'Eratosthenes', 'Eratóstenes', 'Eratostenes', 'crater', 14.5, -11.3, 58),
  feature('grimaldi', 'Grimaldi', 'Grimaldi', 'Grimaldi', 'crater', -5.2, -68.6, 173),
  feature('gassendi', 'Gassendi', 'Gassendi', 'Gassendi', 'crater', -17.6, -40.1, 110),
  feature('schickard', 'Schickard', 'Schickard', 'Schickard', 'crater', -44.3, -54.6, 206),
  feature('langrenus', 'Langrenus', 'Langrenus', 'Langrenus', 'crater', -8.9, 61.0, 132),
  feature('petavius', 'Petavius', 'Petavius', 'Petavius', 'crater', -25.3, 60.4, 184),
  feature('posidonius', 'Posidonius', 'Posidonio', 'Posidonio', 'crater', 31.9, 29.9, 95),
  feature('aristoteles', 'Aristoteles', 'Aristóteles', 'Aristoteles', 'crater', 50.2, 17.3, 88),
  feature('proclus', 'Proclus', 'Proclo', 'Proklo', 'crater', 16.1, 46.8, 27),

  // Lugares de alunizaje tripulados (el Apolo 13 no llegó a alunizar).
  feature('apollo-11', 'Apollo 11', 'Apolo 11', 'Apolo 11', 'landingSite', 0.7, 23.5, 0),
  feature('apollo-12', 'Apollo 12', 'Apolo 12', 'Apolo 12', 'landingSite', -3.0, -23.4, 0),
  feature('apollo-14', 'Apollo 14', 'Apolo 14', 'Apolo 14', 'landingSite', -3.6, -17.5, 0),
  feature('apollo-15', 'Apollo 15', 'Apolo 15', 'Apolo 15', 'landingSite', 26.1, 3.6, 0),
  feature('apollo-16', 'Apollo 16', 'Apolo 16', 'Apolo 16', 'landingSite', -9.0, 15.5, 0),
  feature('apollo-17', 'Apollo 17', 'Apolo 17', 'Apolo 17', 'landingSite', 20.2, 30.8, 0),
];

/** Radio medio de la Luna, para pasar diámetros en km a fracción del radio del disco. */
export const moonRadiusKilometers = 1737.4;

export interface LunarDiskView {
  /** Centro y radio del disco en la imagen (p. ej., de `fitLunarDisk`), en píxeles. */
  centerX: number;
  centerY: number;
  radiusPixels: number;
  /** Libración (de `computeLunarOrientation`): el punto selenográfico que se ve en el centro. */
  librationLongitudeDegrees: number;
  librationLatitudeDegrees: number;
  /** Ángulo del norte lunar en la imagen (de `computeLunarNorthAngleInImageDegrees`). */
  northAngleDegrees: number;
  /** Punto subsolar, para saber qué está iluminado. Sin él, todo se da por iluminado. */
  subsolarPoint?: SelenographicPoint;
  /** Espejo horizontal (diagonal de un telescopio o foto de una pantalla vista por detrás). */
  isMirroredHorizontally?: boolean;
}

export interface ProjectedFeature {
  /** Posición en la imagen, en píxeles (x a la derecha, y hacia abajo). */
  imageX: number;
  imageY: number;
  /** Radio aparente en píxeles, medido a lo largo del limbo (sin el escorzo). */
  apparentRadiusPixels: number;
  /** Delante del limbo (se ve desde la Tierra). */
  isOnVisibleSide: boolean;
  /** Del lado de día del terminador. */
  isIlluminated: boolean;
  /** Altura del Sol sobre el horizonte local, en grados: las sombras largas (0-15°) marcan el relieve. */
  sunAltitudeDegrees: number;
}

const degreesToRadians = Math.PI / 180;

/** Vector unitario de un punto selenográfico en ejes con z hacia la dirección (lon, lat) de referencia. */
function unitVectorRelativeTo(
  latitudeDegrees: number,
  longitudeDegrees: number,
  referenceLatitudeDegrees: number,
  referenceLongitudeDegrees: number,
) {
  const latitude = latitudeDegrees * degreesToRadians;
  const longitudeDifference = (longitudeDegrees - referenceLongitudeDegrees) * degreesToRadians;
  const referenceLatitude = referenceLatitudeDegrees * degreesToRadians;
  return {
    // Hacia el este IAU (derecha con el norte lunar arriba).
    eastComponent: Math.cos(latitude) * Math.sin(longitudeDifference),
    // Hacia el norte lunar, en el plano del cielo.
    northComponent:
      Math.cos(referenceLatitude) * Math.sin(latitude) -
      Math.sin(referenceLatitude) * Math.cos(latitude) * Math.cos(longitudeDifference),
    // Hacia el observador (o el Sol).
    towardReferenceComponent:
      Math.sin(referenceLatitude) * Math.sin(latitude) +
      Math.cos(referenceLatitude) * Math.cos(latitude) * Math.cos(longitudeDifference),
  };
}

/**
 * Proyección ortográfica de un punto selenográfico sobre la imagen. El disco se ve desde tan
 * lejos (60 radios terrestres) que la perspectiva no se nota.
 */
export function projectSelenographicPoint(
  point: SelenographicPoint,
  view: LunarDiskView,
): Omit<ProjectedFeature, 'apparentRadiusPixels'> {
  const { eastComponent, northComponent, towardReferenceComponent } = unitVectorRelativeTo(
    point.latitudeDegrees,
    point.longitudeDegrees,
    view.librationLatitudeDegrees,
    view.librationLongitudeDegrees,
  );
  const northAngle = view.northAngleDegrees * degreesToRadians;
  // Giro antihorario (con y hacia arriba) del norte lunar a su sitio en la imagen.
  const rightComponent = eastComponent * Math.cos(northAngle) - northComponent * Math.sin(northAngle);
  const upComponent = eastComponent * Math.sin(northAngle) + northComponent * Math.cos(northAngle);
  const horizontalSign = view.isMirroredHorizontally ? -1 : 1;

  let sunAltitudeDegrees = 90;
  if (view.subsolarPoint) {
    const sunDirection = unitVectorRelativeTo(
      point.latitudeDegrees,
      point.longitudeDegrees,
      view.subsolarPoint.latitudeDegrees,
      view.subsolarPoint.longitudeDegrees,
    );
    sunAltitudeDegrees = Math.asin(Math.max(-1, Math.min(1, sunDirection.towardReferenceComponent))) / degreesToRadians;
  }
  return {
    imageX: view.centerX + horizontalSign * rightComponent * view.radiusPixels,
    imageY: view.centerY - upComponent * view.radiusPixels,
    isOnVisibleSide: towardReferenceComponent > 0,
    isIlluminated: sunAltitudeDegrees > 0,
    sunAltitudeDegrees,
  };
}

/** Proyecta todos los accidentes del catálogo (o los indicados) sobre la imagen del disco. */
export function projectLunarFeatures(
  view: LunarDiskView,
  features: readonly LunarFeature[] = lunarFeatures,
): (ProjectedFeature & { feature: LunarFeature })[] {
  return features.map((lunarFeature) => ({
    feature: lunarFeature,
    ...projectSelenographicPoint(lunarFeature, view),
    apparentRadiusPixels: (lunarFeature.diameterKilometers / 2 / moonRadiusKilometers) * view.radiusPixels,
  }));
}

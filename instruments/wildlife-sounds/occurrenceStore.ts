import { File } from 'expo-file-system';

import type { FaunaManifest } from './modelManifest';
import { modelDirectory, modelReleaseBaseUrl } from './modelStore';
import { type OccurrenceData, parseOccurrenceData } from './occurrenceFilter';

/**
 * Fichero de presencia por lugar y época (unos cientos de kB). Se descarga junto al modelo, en su
 * misma carpeta, así que «Borrar el modelo» también lo borra. Es opcional: si la release todavía
 * no lo tiene o no hay conexión, el instrumento funciona sin filtro y lo vuelve a intentar la
 * próxima vez que se abre.
 */

/** Presencia ya descargada y válida, o `null`. No lanza. */
export async function readInstalledOccurrence(manifest: FaunaManifest): Promise<OccurrenceData | null> {
  try {
    const occurrenceFile = new File(modelDirectory(), manifest.occurrenceFile);
    if (!occurrenceFile.exists) return null;
    return parseOccurrenceData(JSON.parse(await occurrenceFile.text()));
  } catch {
    return null;
  }
}

/** Descarga, valida y guarda el fichero de presencia. Lanza si no está o no es válido. */
export async function downloadOccurrence(manifest: FaunaManifest, abortSignal: AbortSignal): Promise<OccurrenceData> {
  const occurrenceResponse = await fetch(modelReleaseBaseUrl + manifest.occurrenceFile, { signal: abortSignal });
  if (!occurrenceResponse.ok) throw new Error(`HTTP ${occurrenceResponse.status}`);
  const occurrenceText = await occurrenceResponse.text();
  // Se valida antes de guardarlo: un fichero roto no debe quedarse instalado.
  const occurrenceData = parseOccurrenceData(JSON.parse(occurrenceText));
  const targetDirectory = modelDirectory();
  // Si el modelo se ha borrado mientras tanto, no se recrea la carpeta solo para esto.
  if (!targetDirectory.exists) return occurrenceData;
  const occurrenceFile = new File(targetDirectory, manifest.occurrenceFile);
  occurrenceFile.create({ overwrite: true });
  occurrenceFile.write(occurrenceText);
  return occurrenceData;
}

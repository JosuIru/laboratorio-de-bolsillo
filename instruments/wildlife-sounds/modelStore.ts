import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';

import { type FaunaManifest, parseFaunaManifest } from './modelManifest';

/**
 * Descarga, comprobación y borrado del modelo de fauna. El modelo no va en el APK (pesa ≈37 MB):
 * se descarga una vez de una release de GitHub a la carpeta de documentos y desde entonces
 * funciona sin conexión. El manifiesto se escribe el último: si está, el modelo está completo.
 */

/** Release de GitHub con el modelo (ver scripts/fauna-model/README.md). */
export const modelReleaseBaseUrl =
  'https://github.com/JosuIru/laboratorio-de-bolsillo/releases/download/modelo-fauna-europa-1/';
const manifestFileName = 'fauna-manifest.json';
/** Tamaño aproximado que se anuncia antes de saber el exacto (el del manifiesto). */
export const approximateModelMegabytes = 37;

function modelDirectory(): Directory {
  return new Directory(Paths.document, 'wildlife-sounds', 'model');
}

export interface InstalledModel {
  manifest: FaunaManifest;
  /** URI `file://` del .tflite. */
  modelFileUri: string;
}

/** Modelo ya descargado y completo, o `null`. No lanza. */
export function readInstalledModel(): InstalledModel | null {
  try {
    const manifestFile = new File(modelDirectory(), manifestFileName);
    if (!manifestFile.exists) return null;
    const manifest = parseFaunaManifest(JSON.parse(manifestFile.textSync()));
    const modelFile = new File(modelDirectory(), manifest.modelFile);
    if (!modelFile.exists || modelFile.size !== manifest.modelBytes) return null;
    return { manifest, modelFileUri: modelFile.uri };
  } catch {
    return null;
  }
}

/** Descarga y valida el manifiesto (pocos cientos de kB): da el tamaño exacto antes de bajar el modelo. */
export async function fetchRemoteManifest(): Promise<FaunaManifest> {
  const manifestResponse = await fetch(modelReleaseBaseUrl + manifestFileName);
  if (!manifestResponse.ok) throw new Error(`HTTP ${manifestResponse.status}`);
  return parseFaunaManifest(await manifestResponse.json());
}

export function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byteValue) => byteValue.toString(16).padStart(2, '0')).join('');
}

export type ModelDownloadStage = 'downloading' | 'verifying';

export interface ModelDownloadProgress {
  stage: ModelDownloadStage;
  bytesWritten: number;
  totalBytes: number;
}

/**
 * Comprueba el SHA-256 del fichero. Lee el fichero entero a memoria (37 MB, una sola vez tras la
 * descarga). Devuelve `null` si el móvil no puede calcularlo: entonces vale con el tamaño.
 */
async function computeFileSha256(modelFile: File): Promise<string | null> {
  let fileBytes: Uint8Array<ArrayBuffer>;
  try {
    fileBytes = await modelFile.bytes();
  } catch {
    return null;
  }
  try {
    return bytesToHex(await digest(CryptoDigestAlgorithm.SHA256, fileBytes));
  } catch {
    return null;
  }
}

export class ModelIntegrityError extends Error {
  constructor(problem: string) {
    super(problem);
    this.name = 'ModelIntegrityError';
  }
}

/** Descarga el modelo del manifiesto, lo comprueba y lo deja instalado. */
export async function downloadModel(
  manifest: FaunaManifest,
  onProgress: (downloadProgress: ModelDownloadProgress) => void,
  abortSignal: AbortSignal,
): Promise<InstalledModel> {
  // Solo un modelo instalado a la vez: se borra lo anterior (versiones viejas, restos a medias).
  deleteInstalledModel();
  const targetDirectory = modelDirectory();
  targetDirectory.create({ intermediates: true, idempotent: true });
  const modelFile = new File(targetDirectory, manifest.modelFile);
  try {
    await File.downloadFileAsync(modelReleaseBaseUrl + manifest.modelFile, modelFile, {
      idempotent: true,
      signal: abortSignal,
      onProgress: ({ bytesWritten, totalBytes }) =>
        onProgress({ stage: 'downloading', bytesWritten, totalBytes: totalBytes > 0 ? totalBytes : manifest.modelBytes }),
    });
    onProgress({ stage: 'verifying', bytesWritten: manifest.modelBytes, totalBytes: manifest.modelBytes });
    if (modelFile.size !== manifest.modelBytes) {
      throw new ModelIntegrityError(`tamaño ${modelFile.size ?? '?'} en vez de ${manifest.modelBytes}`);
    }
    const fileSha256 = await computeFileSha256(modelFile);
    if (fileSha256 !== null && fileSha256 !== manifest.modelSha256) {
      throw new ModelIntegrityError('el SHA-256 no coincide');
    }
    const manifestFile = new File(targetDirectory, manifestFileName);
    manifestFile.create({ overwrite: true });
    manifestFile.write(JSON.stringify(manifest));
    return { manifest, modelFileUri: modelFile.uri };
  } catch (downloadError) {
    deleteInstalledModel();
    throw downloadError;
  }
}

/** Borra el modelo y su manifiesto. No lanza. */
export function deleteInstalledModel(): void {
  try {
    const targetDirectory = modelDirectory();
    if (targetDirectory.exists) targetDirectory.delete();
  } catch {
    // Si no se puede borrar, la próxima descarga lo sobrescribe.
  }
}

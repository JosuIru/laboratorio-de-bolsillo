import Constants from 'expo-constants';
import { Directory, File, Paths } from 'expo-file-system';
import { ActivityAction, startActivityAsync } from 'expo-intent-launcher';
import { Platform } from 'react-native';

import {
  applicationIdFromContentUri,
  downloadedApkFileName,
  isDownloadedApkComplete,
  isDownloadedFileObsolete,
  partialDownloadSuffix,
} from './downloadedApkFiles';
import type { AvailableRelease } from './releaseSelection';

/**
 * Descarga del APK de una release dentro de la app (solo Android) y apertura del instalador del
 * sistema. El APK va a la caché de la app, no a Descargas: hay un solo fichero por versión, se
 * reaprovecha si ya está completo y se borra cuando deja de hacer falta.
 */

const apkMimeType = 'application/vnd.android.package-archive';
/** `Intent.FLAG_GRANT_READ_URI_PERMISSION`: el instalador puede leer nuestra content URI. */
const flagGrantReadUriPermission = 0x00000001;
const installPackageAction = 'android.intent.action.INSTALL_PACKAGE';
const viewAction = 'android.intent.action.VIEW';

export const isInAppInstallSupported = Platform.OS === 'android';

function updatesDirectory(): Directory {
  return new Directory(Paths.cache, 'updates');
}

export type ApkDownloadFailureReason = 'already-downloading' | 'cancelled' | 'network' | 'incomplete';

export class ApkDownloadError extends Error {
  constructor(readonly reason: ApkDownloadFailureReason) {
    super(`No se pudo descargar la actualización (${reason})`);
    this.name = 'ApkDownloadError';
  }
}

export interface ApkDownloadProgress {
  downloadedBytes: number;
  /** `null` si no se conoce el tamaño total. */
  totalBytes: number | null;
}

/** Evita dos descargas a la vez aunque se pulse el botón dos veces o se salga y se vuelva a la pantalla. */
let isDownloadInProgress = false;

function deleteQuietly(fileOrDirectory: File | Directory): void {
  try {
    if (fileOrDirectory.exists) fileOrDirectory.delete();
  } catch {
    // Si no se puede borrar ahora, se intentará en la próxima limpieza.
  }
}

function listDownloadedEntries(): (File | Directory)[] {
  const downloadsDirectory = updatesDirectory();
  if (!downloadsDirectory.exists) return [];
  return downloadsDirectory.list();
}

/**
 * Borra de la caché los APK que ya no sirven: los de versiones iguales o anteriores a la
 * instalada (la actualización ya se hizo) y las descargas a medias. Se llama al arrancar la app.
 */
export function removeObsoleteDownloadedApks(installedVersionText: string): void {
  if (!isInAppInstallSupported || isDownloadInProgress) return;
  try {
    for (const downloadedEntry of listDownloadedEntries()) {
      if (downloadedEntry instanceof Directory || isDownloadedFileObsolete(downloadedEntry.name, installedVersionText)) {
        deleteQuietly(downloadedEntry);
      }
    }
  } catch {
    // La limpieza nunca debe impedir que la app arranque.
  }
}

/** El APK de esta release si ya está descargado y completo; si no, `null`. */
export function findDownloadedApk(release: AvailableRelease): File | null {
  if (!isInAppInstallSupported) return null;
  try {
    const downloadedApk = new File(updatesDirectory(), downloadedApkFileName(release.version));
    return downloadedApk.exists && isDownloadedApkComplete(downloadedApk.size, release.apkSizeBytes)
      ? downloadedApk
      : null;
  } catch {
    return null;
  }
}

/**
 * Descarga el APK de la release en la caché de la app. Si ya estaba completo, no lo vuelve a
 * bajar. Antes borra cualquier APK anterior. Se descarga a un fichero `.part` y solo se renombra
 * a `.apk` cuando está completo, así que un `.apk` en la caché siempre es un fichero entero.
 */
export async function downloadReleaseApk(
  release: AvailableRelease,
  {
    onProgress,
    abortSignal,
  }: { onProgress?: (downloadProgress: ApkDownloadProgress) => void; abortSignal?: AbortSignal } = {},
): Promise<File> {
  if (!release.apkDownloadUrl) throw new ApkDownloadError('network');
  if (isDownloadInProgress) throw new ApkDownloadError('already-downloading');

  const alreadyDownloadedApk = findDownloadedApk(release);
  if (alreadyDownloadedApk) return alreadyDownloadedApk;

  isDownloadInProgress = true;
  const finalFileName = downloadedApkFileName(release.version);
  const downloadsDirectory = updatesDirectory();
  const partialApk = new File(downloadsDirectory, `${finalFileName}${partialDownloadSuffix}`);
  try {
    // Lo que quede en la carpeta (APK viejos, descargas a medias o un APK incompleto) sobra.
    for (const downloadedEntry of listDownloadedEntries()) deleteQuietly(downloadedEntry);
    downloadsDirectory.create({ intermediates: true, idempotent: true });

    try {
      await File.downloadFileAsync(release.apkDownloadUrl, partialApk, {
        idempotent: true,
        signal: abortSignal,
        onProgress: ({ bytesWritten, totalBytes }) =>
          onProgress?.({
            downloadedBytes: bytesWritten,
            totalBytes: totalBytes > 0 ? totalBytes : release.apkSizeBytes,
          }),
      });
    } catch {
      throw new ApkDownloadError(abortSignal?.aborted ? 'cancelled' : 'network');
    }

    const downloadedSizeBytes = partialApk.exists ? partialApk.size : 0;
    if (!isDownloadedApkComplete(downloadedSizeBytes, release.apkSizeBytes)) {
      throw new ApkDownloadError('incomplete');
    }
    partialApk.rename(finalFileName);
    return new File(downloadsDirectory, finalFileName);
  } catch (downloadError) {
    deleteQuietly(partialApk);
    throw downloadError instanceof ApkDownloadError ? downloadError : new ApkDownloadError('network');
  } finally {
    isDownloadInProgress = false;
  }
}

/**
 * Abre el instalador del sistema con el APK descargado. Se le pasa la content URI del
 * FileProvider de expo-file-system (cubre la caché) con permiso de lectura. Si Android no deja
 * instalar apps desde esta, el propio instalador lo avisa; `openUnknownSourcesSettings` lleva al ajuste.
 */
export async function openApkInstaller(downloadedApk: File): Promise<void> {
  const installerParams = { data: downloadedApk.contentUri, type: apkMimeType, flags: flagGrantReadUriPermission };
  try {
    await startActivityAsync(installPackageAction, installerParams);
  } catch {
    // Si el sistema no atiende INSTALL_PACKAGE (obsoleto desde Android 10), VIEW abre el mismo instalador.
    await startActivityAsync(viewAction, installerParams);
  }
}

function currentApplicationId(downloadedApk: File | null): string | null {
  if (downloadedApk) {
    try {
      const applicationId = applicationIdFromContentUri(downloadedApk.contentUri);
      if (applicationId) return applicationId;
    } catch {
      // Se usa el id de app.json.
    }
  }
  return Constants.expoConfig?.android?.package ?? null;
}

/** Abre el ajuste «Instalar apps desconocidas» de esta app (o la lista general si no se puede). */
export async function openUnknownSourcesSettings(downloadedApk: File | null): Promise<void> {
  const applicationId = currentApplicationId(downloadedApk);
  try {
    await startActivityAsync(
      ActivityAction.MANAGE_UNKNOWN_APP_SOURCES,
      applicationId ? { data: `package:${applicationId}` } : {},
    );
  } catch {
    await startActivityAsync(ActivityAction.MANAGE_UNKNOWN_APP_SOURCES);
  }
}

import { compareSemanticVersions, parseSemanticVersion } from './releaseSelection';

/**
 * Nombres de los APK que la app descarga en su caché. Lógica pura (sin Expo) para poder probarla:
 * el acceso a ficheros está en `apkInstaller.ts`.
 */
const downloadedApkPrefix = 'laboratorio-de-bolsillo-';
const downloadedApkExtension = '.apk';
/** Sufijo del fichero mientras se descarga: solo se renombra a `.apk` cuando está completo. */
export const partialDownloadSuffix = '.part';

/** Un solo fichero por versión: `laboratorio-de-bolsillo-0.5.0.apk`. */
export function downloadedApkFileName(versionText: string): string {
  return `${downloadedApkPrefix}${versionText}${downloadedApkExtension}`;
}

/** Versión de un APK descargado a partir de su nombre, o `null` si el nombre no es de los nuestros. */
export function parseDownloadedApkVersion(fileName: string): string | null {
  if (!fileName.startsWith(downloadedApkPrefix) || !fileName.endsWith(downloadedApkExtension)) return null;
  const versionText = fileName.slice(downloadedApkPrefix.length, -downloadedApkExtension.length);
  return parseSemanticVersion(versionText) ? versionText : null;
}

/**
 * Decide si un fichero de la carpeta de descargas sobra: descargas a medias, nombres que no
 * reconocemos y APK de una versión igual o anterior a la instalada (ya se instaló).
 */
export function isDownloadedFileObsolete(fileName: string, installedVersionText: string): boolean {
  const downloadedVersionText = parseDownloadedApkVersion(fileName);
  if (!downloadedVersionText) return true;
  const downloadedVersion = parseSemanticVersion(downloadedVersionText)!;
  const installedVersion = parseSemanticVersion(installedVersionText);
  if (!installedVersion) return false;
  return compareSemanticVersions(downloadedVersion, installedVersion) <= 0;
}

/** El APK descargado está completo si mide lo mismo que el asset de la release (si se conoce). */
export function isDownloadedApkComplete(fileSizeBytes: number, expectedSizeBytes: number | null): boolean {
  if (fileSizeBytes <= 0) return false;
  return expectedSizeBytes === null || fileSizeBytes === expectedSizeBytes;
}

/**
 * Id de la app a partir de la content URI que da expo-file-system
 * (`content://<applicationId>.FileSystemFileProvider/...`). Así sirve también en el dev build (`.dev`).
 */
export function applicationIdFromContentUri(contentUri: string): string | null {
  const authorityMatch = /^content:\/\/([^/]+)\.FileSystemFileProvider(?:\/|$)/.exec(contentUri);
  return authorityMatch ? authorityMatch[1]! : null;
}

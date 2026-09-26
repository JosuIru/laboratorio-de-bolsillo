/** Versión semántica `MAYOR.MENOR.PARCHE`, con prefijo `v` opcional (`v0.2.0`). */
export interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
}

const semanticVersionPattern = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export function parseSemanticVersion(versionText: string): SemanticVersion | null {
  const versionMatch = semanticVersionPattern.exec(versionText.trim());
  if (!versionMatch) return null;
  return { major: Number(versionMatch[1]), minor: Number(versionMatch[2]), patch: Number(versionMatch[3]) };
}

/** Negativo si `leftVersion` es anterior, 0 si son iguales y positivo si es posterior. */
export function compareSemanticVersions(leftVersion: SemanticVersion, rightVersion: SemanticVersion): number {
  return (
    leftVersion.major - rightVersion.major ||
    leftVersion.minor - rightVersion.minor ||
    leftVersion.patch - rightVersion.patch
  );
}

/** Campos que usamos de la respuesta de la API de GitHub (`GET /repos/{owner}/{repo}/releases/latest`). */
export interface GitHubReleaseResponse {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

export interface AvailableRelease {
  version: string;
  releaseName: string;
  releaseNotes: string;
  releasePageUrl: string;
  publishedAt: string | null;
  /** Descarga directa del APK, si la release lo incluye. */
  apkDownloadUrl: string | null;
  apkSizeBytes: number | null;
  /** Arquitectura del APK elegido, o `null` si es el universal. */
  apkAbi: AndroidAbi | null;
}

export type UpdateCheckResult =
  | { status: 'up-to-date'; currentVersion: string; latestVersion: string }
  | { status: 'update-available'; currentVersion: string; release: AvailableRelease }
  | { status: 'no-releases' };

const trustedDownloadHosts = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];

/** Solo aceptamos enlaces https a GitHub: nunca abrimos una URL arbitraria recibida por red. */
export function isTrustedGitHubUrl(candidateUrl: string): boolean {
  const urlMatch = /^https:\/\/([^/:?#]+)(?:[/?#]|$)/i.exec(candidateUrl);
  return !!urlMatch && trustedDownloadHosts.includes(urlMatch[1]!.toLowerCase());
}

/** Arquitecturas (ABI de Android) para las que se publican APK específicos. */
export const knownAndroidAbis = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'] as const;
export type AndroidAbi = (typeof knownAndroidAbis)[number];

export interface SelectedApkAsset {
  fileName: string;
  downloadUrl: string;
  sizeBytes: number | null;
  /** ABI del APK, o `null` si es el universal (vale para cualquier móvil). */
  abi: AndroidAbi | null;
}

/**
 * Deduce la arquitectura de un APK por su nombre:
 * `laboratorio-de-bolsillo-0.5.0-arm64-v8a.apk` → `arm64-v8a`; el universal no lleva sufijo
 * (`laboratorio-de-bolsillo-0.5.0.apk`) o lleva `-universal`. El sufijo `-arm64` de las pruebas
 * locales equivale a `arm64-v8a`.
 */
export function detectApkAbi(apkFileName: string): AndroidAbi | null {
  const lowerCaseName = apkFileName.toLowerCase();
  const matchedAbi = knownAndroidAbis.find((androidAbi) => lowerCaseName.endsWith(`-${androidAbi}.apk`));
  if (matchedAbi) return matchedAbi;
  if (lowerCaseName.endsWith('-arm64.apk')) return 'arm64-v8a';
  return null;
}

/** Normaliza lo que da el sistema (`Device.supportedCpuArchitectures`) a ABI conocidas, en orden de preferencia. */
function normalizeDeviceAbis(deviceCpuArchitectures: readonly string[] | null): AndroidAbi[] {
  if (!deviceCpuArchitectures) return [];
  const normalizedAbis: AndroidAbi[] = [];
  for (const cpuArchitecture of deviceCpuArchitectures) {
    const matchedAbi = knownAndroidAbis.find((androidAbi) => androidAbi === cpuArchitecture.trim().toLowerCase());
    if (matchedAbi && !normalizedAbis.includes(matchedAbi)) normalizedAbis.push(matchedAbi);
  }
  return normalizedAbis;
}

/**
 * Elige el APK de la release: el de la arquitectura preferida del móvil si lo hay (el sistema
 * las da en orden: `arm64-v8a` antes que `armeabi-v7a`) y, si no, el universal. Nunca elige un
 * APK de otra arquitectura, porque no se podría instalar.
 */
export function pickApkAsset(
  rawAssets: unknown,
  deviceCpuArchitectures: readonly string[] | null = null,
): SelectedApkAsset | null {
  if (!Array.isArray(rawAssets)) return null;
  const apkAssets: SelectedApkAsset[] = [];
  for (const rawAsset of rawAssets) {
    const asset = rawAsset as { name?: unknown; browser_download_url?: unknown; size?: unknown };
    if (
      typeof asset.name === 'string' &&
      asset.name.toLowerCase().endsWith('.apk') &&
      typeof asset.browser_download_url === 'string' &&
      isTrustedGitHubUrl(asset.browser_download_url)
    ) {
      apkAssets.push({
        fileName: asset.name,
        downloadUrl: asset.browser_download_url,
        sizeBytes: typeof asset.size === 'number' && asset.size > 0 ? asset.size : null,
        abi: detectApkAbi(asset.name),
      });
    }
  }
  for (const deviceAbi of normalizeDeviceAbis(deviceCpuArchitectures)) {
    const architectureApk = apkAssets.find((apkAsset) => apkAsset.abi === deviceAbi);
    if (architectureApk) return architectureApk;
  }
  return apkAssets.find((apkAsset) => apkAsset.abi === null) ?? null;
}

/**
 * Decide si la release publicada es más nueva que la versión instalada.
 * Ignora borradores, prereleases y tags que no sean versiones semánticas.
 */
export function evaluateLatestRelease(
  currentVersionText: string,
  latestRelease: GitHubReleaseResponse | null,
  deviceCpuArchitectures: readonly string[] | null = null,
): UpdateCheckResult {
  if (!latestRelease || latestRelease.draft === true || latestRelease.prerelease === true) {
    return { status: 'no-releases' };
  }
  const tagName = typeof latestRelease.tag_name === 'string' ? latestRelease.tag_name : '';
  const latestVersion = parseSemanticVersion(tagName);
  const currentVersion = parseSemanticVersion(currentVersionText);
  if (!latestVersion || !currentVersion) return { status: 'no-releases' };

  const latestVersionText = `${latestVersion.major}.${latestVersion.minor}.${latestVersion.patch}`;
  if (compareSemanticVersions(latestVersion, currentVersion) <= 0) {
    return { status: 'up-to-date', currentVersion: currentVersionText, latestVersion: latestVersionText };
  }

  const releasePageUrl =
    typeof latestRelease.html_url === 'string' && isTrustedGitHubUrl(latestRelease.html_url)
      ? latestRelease.html_url
      : '';
  const apkAsset = pickApkAsset(latestRelease.assets, deviceCpuArchitectures);
  return {
    status: 'update-available',
    currentVersion: currentVersionText,
    release: {
      version: latestVersionText,
      releaseName: typeof latestRelease.name === 'string' && latestRelease.name.trim() ? latestRelease.name : tagName,
      releaseNotes: typeof latestRelease.body === 'string' ? latestRelease.body.trim() : '',
      releasePageUrl,
      publishedAt: typeof latestRelease.published_at === 'string' ? latestRelease.published_at : null,
      apkDownloadUrl: apkAsset?.downloadUrl ?? null,
      apkSizeBytes: apkAsset?.sizeBytes ?? null,
      apkAbi: apkAsset?.abi ?? null,
    },
  };
}

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

function pickApkAsset(rawAssets: unknown): { downloadUrl: string; sizeBytes: number | null } | null {
  if (!Array.isArray(rawAssets)) return null;
  for (const rawAsset of rawAssets) {
    const asset = rawAsset as { name?: unknown; browser_download_url?: unknown; size?: unknown };
    if (
      typeof asset.name === 'string' &&
      asset.name.toLowerCase().endsWith('.apk') &&
      typeof asset.browser_download_url === 'string' &&
      isTrustedGitHubUrl(asset.browser_download_url)
    ) {
      return {
        downloadUrl: asset.browser_download_url,
        sizeBytes: typeof asset.size === 'number' ? asset.size : null,
      };
    }
  }
  return null;
}

/**
 * Decide si la release publicada es más nueva que la versión instalada.
 * Ignora borradores, prereleases y tags que no sean versiones semánticas.
 */
export function evaluateLatestRelease(
  currentVersionText: string,
  latestRelease: GitHubReleaseResponse | null,
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
  const apkAsset = pickApkAsset(latestRelease.assets);
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
    },
  };
}

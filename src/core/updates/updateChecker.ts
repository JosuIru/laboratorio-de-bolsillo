import Constants from 'expo-constants';

import { evaluateLatestRelease, type GitHubReleaseResponse, type UpdateCheckResult } from './releaseSelection';

/** Repositorio público donde se publican las releases con el APK. */
export const releaseRepository = { owner: 'JosuIru', name: 'laboratorio-de-bolsillo' } as const;

export const repositoryUrl = `https://github.com/${releaseRepository.owner}/${releaseRepository.name}`;

const latestReleaseApiUrl = `https://api.github.com/repos/${releaseRepository.owner}/${releaseRepository.name}/releases/latest`;
const requestTimeoutMilliseconds = 10_000;

export function getInstalledVersion(): string {
  return Constants.expoConfig?.version ?? '0.0.0';
}

export class UpdateCheckError extends Error {
  constructor(readonly reason: 'network' | 'rate-limited' | 'unexpected-response') {
    super(`No se pudo comprobar si hay actualizaciones (${reason})`);
    this.name = 'UpdateCheckError';
  }
}

/**
 * Consulta la última release en GitHub. Es la única conexión de red de la app y solo se
 * hace cuando el usuario la pide: no se envía ningún dato del usuario ni del dispositivo.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), requestTimeoutMilliseconds);
  let response: Response;
  try {
    response = await fetch(latestReleaseApiUrl, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: abortController.signal,
    });
  } catch {
    throw new UpdateCheckError('network');
  } finally {
    clearTimeout(timeoutHandle);
  }

  // GitHub responde 404 cuando todavía no hay ninguna release publicada.
  if (response.status === 404) return evaluateLatestRelease(getInstalledVersion(), null);
  if (response.status === 403 || response.status === 429) throw new UpdateCheckError('rate-limited');
  if (!response.ok) throw new UpdateCheckError('unexpected-response');

  let latestRelease: GitHubReleaseResponse;
  try {
    latestRelease = (await response.json()) as GitHubReleaseResponse;
  } catch {
    throw new UpdateCheckError('unexpected-response');
  }
  return evaluateLatestRelease(getInstalledVersion(), latestRelease);
}

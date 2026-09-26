import { useCallback, useEffect, useState } from 'react';

import type { FaunaManifest } from './modelManifest';
import type { OccurrenceData } from './occurrenceFilter';
import { downloadOccurrence, readInstalledOccurrence } from './occurrenceStore';

export type OccurrenceState =
  | { status: 'absent' }
  | { status: 'loading' }
  | { status: 'ready'; occurrenceData: OccurrenceData }
  | { status: 'unavailable'; errorMessage: string };

/**
 * Datos de presencia del modelo instalado: los lee del disco o, si no están, los descarga (una vez
 * por cada vez que se abre la pantalla o se pulsa «Reintentar»). Nunca bloquea el instrumento.
 */
export function useOccurrenceData(installedManifest: FaunaManifest | null) {
  const [retryCount, setRetryCount] = useState(0);
  const loadKey = installedManifest ? `${installedManifest.modelVersion}|${installedManifest.occurrenceFile}|${retryCount}` : null;
  const [occurrenceEntry, setOccurrenceEntry] = useState<{ loadKey: string | null; state: OccurrenceState }>({
    loadKey: null,
    state: { status: 'absent' },
  });
  if (occurrenceEntry.loadKey !== loadKey) {
    setOccurrenceEntry({ loadKey, state: loadKey ? { status: 'loading' } : { status: 'absent' } });
  }

  useEffect(() => {
    if (!installedManifest || loadKey === null) return;
    const abortController = new AbortController();
    void (async () => {
      let occurrenceState: OccurrenceState;
      try {
        const installedOccurrence = await readInstalledOccurrence(installedManifest);
        occurrenceState = {
          status: 'ready',
          occurrenceData: installedOccurrence ?? (await downloadOccurrence(installedManifest, abortController.signal)),
        };
      } catch (occurrenceError) {
        occurrenceState = { status: 'unavailable', errorMessage: String(occurrenceError) };
      }
      if (!abortController.signal.aborted) setOccurrenceEntry({ loadKey, state: occurrenceState });
    })();
    return () => abortController.abort();
  }, [installedManifest, loadKey]);

  const retryOccurrenceDownload = useCallback(() => setRetryCount((previousCount) => previousCount + 1), []);

  return { occurrenceState: occurrenceEntry.state, retryOccurrenceDownload };
}

import { useCallback, useEffect, useRef, useState } from 'react';

import type { FaunaManifest } from './modelManifest';
import {
  deleteInstalledModel,
  downloadModel,
  fetchRemoteManifest,
  type InstalledModel,
  type ModelDownloadProgress,
  readInstalledModel,
} from './modelStore';
import { loadWildlifeClassifier, type ModelAccelerator, type WildlifeClassifier } from './wildlifeClassifier';

export type ModelDownloadState =
  | { status: 'idle' }
  | { status: 'fetching-manifest' }
  | { status: 'downloading'; progress: ModelDownloadProgress | null }
  | { status: 'error'; errorMessage: string };

export type ClassifierState =
  | { status: 'absent' }
  | { status: 'loading' }
  | { status: 'ready'; classifier: WildlifeClassifier }
  | { status: 'error'; errorMessage: string };

/** Los mensajes de progreso llegan muy seguidos: la pantalla se refresca como mucho cada tanto. */
const progressRefreshMilliseconds = 250;

/**
 * Estado del modelo: si está descargado, la descarga (con progreso y cancelación), el borrado y
 * el modelo cargado en memoria, listo para clasificar. Se libera al desmontar la pantalla.
 */
export function useWildlifeModel(requestedAccelerator: ModelAccelerator) {
  const [installedModel, setInstalledModel] = useState<InstalledModel | null>(readInstalledModel);
  const [downloadState, setDownloadState] = useState<ModelDownloadState>({ status: 'idle' });
  const downloadAbortControllerRef = useRef<AbortController | null>(null);
  const lastProgressRefreshRef = useRef(0);

  // El modelo cargado depende del fichero instalado y del acelerador: si cambian, se recarga.
  const classifierLoadKey = installedModel ? `${installedModel.modelFileUri}|${requestedAccelerator}` : null;
  const [classifierEntry, setClassifierEntry] = useState<{ loadKey: string | null; state: ClassifierState }>({
    loadKey: null,
    state: { status: 'absent' },
  });
  if (classifierEntry.loadKey !== classifierLoadKey) {
    setClassifierEntry({ loadKey: classifierLoadKey, state: classifierLoadKey ? { status: 'loading' } : { status: 'absent' } });
  }

  useEffect(() => {
    if (!installedModel) return;
    let isEffectActive = true;
    let loadedClassifier: WildlifeClassifier | null = null;
    const loadKey = `${installedModel.modelFileUri}|${requestedAccelerator}`;
    loadWildlifeClassifier(installedModel, requestedAccelerator)
      .then((classifier) => {
        if (!isEffectActive) {
          classifier.release();
          return;
        }
        loadedClassifier = classifier;
        setClassifierEntry({ loadKey, state: { status: 'ready', classifier } });
      })
      .catch((loadError: unknown) => {
        if (isEffectActive) setClassifierEntry({ loadKey, state: { status: 'error', errorMessage: String(loadError) } });
      });
    return () => {
      isEffectActive = false;
      loadedClassifier?.release();
    };
  }, [installedModel, requestedAccelerator]);

  useEffect(() => () => downloadAbortControllerRef.current?.abort(), []);

  /** Descarga el manifiesto para saber el tamaño exacto antes de pedir confirmación. */
  const fetchManifestForDownload = useCallback(async (): Promise<FaunaManifest | null> => {
    setDownloadState({ status: 'fetching-manifest' });
    try {
      const remoteManifest = await fetchRemoteManifest();
      setDownloadState({ status: 'idle' });
      return remoteManifest;
    } catch (manifestError) {
      setDownloadState({ status: 'error', errorMessage: String(manifestError) });
      return null;
    }
  }, []);

  const startDownload = useCallback(async (manifest: FaunaManifest) => {
    const abortController = new AbortController();
    downloadAbortControllerRef.current = abortController;
    setDownloadState({ status: 'downloading', progress: null });
    try {
      const newlyInstalledModel = await downloadModel(
        manifest,
        (downloadProgress) => {
          const now = Date.now();
          if (downloadProgress.stage === 'downloading' && now - lastProgressRefreshRef.current < progressRefreshMilliseconds) {
            return;
          }
          lastProgressRefreshRef.current = now;
          if (!abortController.signal.aborted) setDownloadState({ status: 'downloading', progress: downloadProgress });
        },
        abortController.signal,
      );
      setInstalledModel(newlyInstalledModel);
      setDownloadState({ status: 'idle' });
    } catch (downloadError) {
      setDownloadState(
        abortController.signal.aborted ? { status: 'idle' } : { status: 'error', errorMessage: String(downloadError) },
      );
    } finally {
      if (downloadAbortControllerRef.current === abortController) downloadAbortControllerRef.current = null;
    }
  }, []);

  const cancelDownload = useCallback(() => {
    downloadAbortControllerRef.current?.abort();
  }, []);

  const deleteModel = useCallback(() => {
    // El efecto de carga libera el modelo al cambiar `installedModel`.
    setInstalledModel(null);
    deleteInstalledModel();
  }, []);

  return {
    installedModel,
    downloadState,
    classifierState: classifierEntry.state,
    fetchManifestForDownload,
    startDownload,
    cancelDownload,
    deleteModel,
  };
}

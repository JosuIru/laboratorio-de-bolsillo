import { Platform } from 'react-native';
import type { TensorflowModelDelegate, TfliteModel } from 'react-native-fast-tflite';

import { type FaunaManifest, type ModelOutputIndices, resolveModelOutputIndices } from './modelManifest';
import type { InstalledModel } from './modelStore';

/**
 * Envoltorio del modelo LiteRT (react-native-fast-tflite). La librería se importa al cargar el
 * modelo, no al importar este fichero: así el resto del instrumento (y los tests del registro)
 * no necesitan el módulo nativo.
 */

export type ModelAccelerator = 'cpu' | 'gpu';

export interface WindowClassification {
  logits: Float32Array;
  embedding: Float32Array;
  /** Log-mel, `spectrogramFrameCount` × `melBinCount`, trama a trama. */
  melSpectrogram: Float32Array;
  spectrogramFrameCount: number;
  melBinCount: number;
  inferenceMilliseconds: number;
}

export interface WildlifeClassifier {
  manifest: FaunaManifest;
  /** Acelerador que se está usando de verdad (si la GPU falla, se vuelve a la CPU). */
  activeAccelerator: ModelAccelerator;
  /** Motivo por el que no se pudo usar la GPU pedida, si es el caso. */
  acceleratorFallbackReason: string | null;
  /** Pasa una ventana de `manifest.windowSamples` muestras a `manifest.sampleRateHz`. No bloquea el hilo JS. */
  classifyWindow(windowSamples: Float32Array): Promise<WindowClassification>;
  release(): void;
}

function gpuDelegatesForPlatform(): TensorflowModelDelegate[] {
  // En Android hace falta además `enableAndroidGpuLibraries` en el plugin de app.json; sin él la
  // carga falla y se usa la CPU. En iOS, Core ML necesita activarse en el Podfile.
  return Platform.OS === 'ios' ? ['core-ml'] : ['android-gpu'];
}

function copyOutput(outputBuffer: ArrayBuffer | undefined): Float32Array {
  if (!outputBuffer) return new Float32Array(0);
  // Copia: el búfer de salida puede reutilizarse en la siguiente inferencia.
  return new Float32Array(outputBuffer.slice(0));
}

function wrapModel(
  loadedModel: TfliteModel,
  manifest: FaunaManifest,
  activeAccelerator: ModelAccelerator,
  acceleratorFallbackReason: string | null,
): WildlifeClassifier {
  const outputIndices: ModelOutputIndices = resolveModelOutputIndices(loadedModel.outputs, manifest);
  const spectrogramShape = loadedModel.outputs[outputIndices.spectrogram]?.shape.filter((dimension) => dimension !== 1) ?? [];
  const spectrogramFrameCount = spectrogramShape[0] ?? 0;
  const melBinCount = spectrogramShape[1] ?? 0;
  let isReleased = false;

  return {
    manifest,
    activeAccelerator,
    acceleratorFallbackReason,
    async classifyWindow(windowSamples) {
      if (isReleased) throw new Error('El modelo ya se ha liberado');
      if (windowSamples.length !== manifest.windowSamples) {
        throw new RangeError(`La ventana debe tener ${manifest.windowSamples} muestras`);
      }
      const startedAt = performance.now();
      const inputBuffer = windowSamples.buffer.slice(
        windowSamples.byteOffset,
        windowSamples.byteOffset + windowSamples.byteLength,
      ) as ArrayBuffer;
      const outputBuffers = await loadedModel.run([inputBuffer]);
      const inferenceMilliseconds = performance.now() - startedAt;
      return {
        logits: copyOutput(outputBuffers[outputIndices.logits]),
        embedding: copyOutput(outputBuffers[outputIndices.embedding]),
        melSpectrogram: copyOutput(outputBuffers[outputIndices.spectrogram]),
        spectrogramFrameCount,
        melBinCount,
        inferenceMilliseconds,
      };
    },
    release() {
      if (isReleased) return;
      isReleased = true;
      try {
        loadedModel.dispose();
      } catch {
        // Si ya no existe, el recolector de basura se encarga.
      }
    },
  };
}

/** Carga el modelo instalado. Con `gpu`, si el delegado falla, carga con la CPU y lo indica. */
export async function loadWildlifeClassifier(
  installedModel: InstalledModel,
  requestedAccelerator: ModelAccelerator,
): Promise<WildlifeClassifier> {
  const { loadTensorflowModel } = await import('react-native-fast-tflite');
  const modelSource = { url: installedModel.modelFileUri };
  if (requestedAccelerator === 'gpu') {
    try {
      const gpuModel = await loadTensorflowModel(modelSource, gpuDelegatesForPlatform());
      return wrapModel(gpuModel, installedModel.manifest, 'gpu', null);
    } catch (gpuError) {
      const cpuModel = await loadTensorflowModel(modelSource, []);
      return wrapModel(cpuModel, installedModel.manifest, 'cpu', String(gpuError));
    }
  }
  const cpuModel = await loadTensorflowModel(modelSource, []);
  return wrapModel(cpuModel, installedModel.manifest, 'cpu', null);
}

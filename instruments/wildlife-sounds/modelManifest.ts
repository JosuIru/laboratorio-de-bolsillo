/**
 * Manifiesto del modelo de fauna (fauna-manifest.json, lo genera
 * scripts/fauna-model/build_manifest.py): qué fichero descargar, cómo comprobarlo, cómo es la
 * entrada, en qué orden salen los resultados y qué es cada clase.
 */

export type SoundClassKind = 'species' | 'sound';
export type SpeciesGroup = 'bird' | 'amphibian' | 'mammal' | 'insect' | 'reptile';

export interface SoundClassNames {
  es: string | null;
  eu: string | null;
  en: string | null;
}

export interface SoundClass {
  /** Nombre científico (especies) o etiqueta de AudioSet/FSD50K (sonidos generales). */
  label: string;
  kind: SoundClassKind;
  group?: SpeciesGroup;
  names: SoundClassNames;
  /** Voz humana: estas detecciones no se guardan. */
  isHumanVoice?: boolean;
}

export interface ModelOutputIndices {
  embedding: number;
  spatialEmbedding: number;
  spectrogram: number;
  logits: number;
}

export interface FaunaManifest {
  formatVersion: 1;
  modelVersion: string;
  modelFile: string;
  modelBytes: number;
  modelSha256: string;
  sampleRateHz: number;
  windowSamples: number;
  outputs: ModelOutputIndices;
  license: string;
  /**
   * Fichero de presencia por lugar y época (ver occurrenceFilter.ts), en la misma release que el
   * modelo. Si el manifiesto no lo trae, se usa `defaultOccurrenceFileName`.
   */
  occurrenceFile: string;
  classes: SoundClass[];
}

export const defaultOccurrenceFileName = 'fauna-occurrence-europa-1.json';

export class ManifestFormatError extends Error {
  constructor(problem: string) {
    super(`Manifiesto del modelo no válido: ${problem}`);
    this.name = 'ManifestFormatError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ManifestFormatError(`«${key}» debe ser un número`);
  return value;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') throw new ManifestFormatError(`«${key}» debe ser un texto`);
  return value;
}

function optionalName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

const speciesGroups: readonly SpeciesGroup[] = ['bird', 'amphibian', 'mammal', 'insect', 'reptile'];

function parseSoundClass(rawClass: unknown, classIndex: number): SoundClass {
  if (!isRecord(rawClass)) throw new ManifestFormatError(`la clase ${classIndex} no es un objeto`);
  const label = requireString(rawClass, 'label');
  const kind = rawClass.kind;
  if (kind !== 'species' && kind !== 'sound') throw new ManifestFormatError(`tipo desconocido en «${label}»`);
  const rawNames = isRecord(rawClass.names) ? rawClass.names : {};
  const soundClass: SoundClass = {
    label,
    kind,
    names: { es: optionalName(rawNames.es), eu: optionalName(rawNames.eu), en: optionalName(rawNames.en) },
  };
  if (speciesGroups.includes(rawClass.group as SpeciesGroup)) soundClass.group = rawClass.group as SpeciesGroup;
  if (rawClass.isHumanVoice === true) soundClass.isHumanVoice = true;
  return soundClass;
}

/** Comprueba y tipa el JSON descargado. Lanza `ManifestFormatError` si no encaja. */
export function parseFaunaManifest(rawManifest: unknown): FaunaManifest {
  if (!isRecord(rawManifest)) throw new ManifestFormatError('no es un objeto');
  if (rawManifest.formatVersion !== 1) {
    throw new ManifestFormatError(`versión de formato ${String(rawManifest.formatVersion)} no admitida`);
  }
  const modelSha256 = requireString(rawManifest, 'modelSha256').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(modelSha256)) throw new ManifestFormatError('«modelSha256» no es un SHA-256');
  const modelFile = requireString(rawManifest, 'modelFile');
  if (!/^[\w.-]+\.tflite$/.test(modelFile)) throw new ManifestFormatError('«modelFile» no es un nombre de fichero .tflite');
  const occurrenceFile =
    rawManifest.occurrenceFile === undefined ? defaultOccurrenceFileName : requireString(rawManifest, 'occurrenceFile');
  if (!/^[\w.-]+\.json$/.test(occurrenceFile)) {
    throw new ManifestFormatError('«occurrenceFile» no es un nombre de fichero .json');
  }
  const rawOutputs = rawManifest.outputs;
  if (!isRecord(rawOutputs)) throw new ManifestFormatError('faltan los índices de salida');
  const rawClasses = rawManifest.classes;
  if (!Array.isArray(rawClasses) || rawClasses.length === 0) throw new ManifestFormatError('no hay clases');
  return {
    formatVersion: 1,
    modelVersion: requireString(rawManifest, 'modelVersion'),
    modelFile,
    modelBytes: requireNumber(rawManifest, 'modelBytes'),
    modelSha256,
    sampleRateHz: requireNumber(rawManifest, 'sampleRateHz'),
    windowSamples: requireNumber(rawManifest, 'windowSamples'),
    outputs: {
      embedding: requireNumber(rawOutputs, 'embedding'),
      spatialEmbedding: requireNumber(rawOutputs, 'spatialEmbedding'),
      spectrogram: requireNumber(rawOutputs, 'spectrogram'),
      logits: requireNumber(rawOutputs, 'logits'),
    },
    license: typeof rawManifest.license === 'string' ? rawManifest.license : '',
    occurrenceFile,
    classes: rawClasses.map(parseSoundClass),
  };
}

/** Forma de un tensor tal como la da el modelo cargado (p. ej. `[1, 1226]`). */
export interface TensorShapeDescription {
  shape: readonly number[];
}

function productOf(dimensions: readonly number[]): number {
  return dimensions.reduce((product, dimension) => product * dimension, 1);
}

/**
 * Decide qué salida del modelo es cada cosa. Se reconocen por su forma (más robusto que el
 * orden, que depende del conversor) y, si alguna no se reconoce, se usa el orden del manifiesto.
 */
export function resolveModelOutputIndices(
  outputTensors: readonly TensorShapeDescription[],
  manifest: Pick<FaunaManifest, 'outputs' | 'classes'>,
): ModelOutputIndices {
  const classCount = manifest.classes.length;
  const findByShape = (matches: (dimensions: readonly number[]) => boolean) =>
    outputTensors.findIndex((outputTensor) => matches(outputTensor.shape.filter((dimension) => dimension !== 1)));
  const logitsIndex = findByShape((dimensions) => dimensions.length === 1 && dimensions[0] === classCount);
  const embeddingIndex = findByShape((dimensions) => dimensions.length === 1 && dimensions[0] === 1536);
  const spectrogramIndex = findByShape((dimensions) => dimensions.length === 2);
  const spatialIndex = findByShape((dimensions) => dimensions.length === 3);
  const byShape = {
    embedding: embeddingIndex,
    spatialEmbedding: spatialIndex,
    spectrogram: spectrogramIndex,
    logits: logitsIndex,
  };
  const isComplete =
    Object.values(byShape).every((outputIndex) => outputIndex >= 0) && new Set(Object.values(byShape)).size === 4;
  if (isComplete) return byShape;
  const manifestIndices = manifest.outputs;
  const logitsTensor = outputTensors[manifestIndices.logits];
  if (!logitsTensor || productOf(logitsTensor.shape) !== classCount) {
    throw new ManifestFormatError('las salidas del modelo no coinciden con el manifiesto');
  }
  return manifestIndices;
}

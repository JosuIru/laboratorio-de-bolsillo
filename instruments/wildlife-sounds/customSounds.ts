import {
  base64ToBytes,
  bytesToBase64,
  decodeFloat16LittleEndian,
  embeddingExportFormat,
  roundScore,
} from './detectionLog';

/**
 * «Enséñale tus sonidos»: clases propias («Mi perro», «La puerta del garaje») a partir de unos
 * pocos ejemplos, sin entrenar nada. De cada ejemplo se guarda solo el embedding de Perch (1536
 * números), nunca el audio, y cada ventana nueva se compara con ellos por similitud coseno.
 * Sin React ni base de datos.
 */

// --- Parámetros ---

/**
 * Similitud mínima por defecto. Los embeddings de Perch salen de una capa tras activaciones y
 * promedios, así que casi todos sus valores son positivos: dos sonidos cualesquiera ya dan
 * cosenos de 0,5-0,7, y el mismo sonido repetido en el mismo sitio suele pasar de 0,9. 0,85 deja
 * margen para variaciones (distancia, otro ladrido) sin aceptar cualquier ruido parecido. Es un
 * valor a ojo, sin calibrar con datos: por eso hay un control de sensibilidad.
 */
export const defaultSimilarityThreshold = 0.85;

export type CustomSoundSensitivity = 'strict' | 'normal' | 'sensitive';

export const similarityThresholdBySensitivity: Record<CustomSoundSensitivity, number> = {
  strict: 0.9,
  normal: defaultSimilarityThreshold,
  sensitive: 0.8,
};

/**
 * Similitud de una clase = media de sus `topExampleCount` ejemplos más parecidos. Con el máximo
 * a secas, un solo ejemplo malo (grabado con ruido) daría falsos positivos; con la media de todos,
 * un perro que ladra de dos maneras no llegaría nunca al umbral.
 */
export const topExampleCount = 2;
/** Ejemplos necesarios para que una clase empiece a reconocerse. */
export const minimumExamplesForMatching = 3;
/** Más ejemplos apenas mejoran y hacen más lenta la comparación. */
export const maximumExamplesPerClass = 10;
export const maximumClassNameLength = 40;

// --- Tipos ---

export interface CustomSoundClass {
  id: number;
  name: string;
  /**
   * Clase «de fondo» (silencio, ruido de casa): no se reconoce nunca; sirve para descartar
   * coincidencias que se parecen más al fondo que a la clase.
   */
  isBackground: boolean;
  createdAtIso: string;
}

export interface CustomSoundExample {
  id: number;
  classId: number;
  recordedAtIso: string;
  modelVersion: string;
  /** Embedding de 1536 valores en float16 little-endian (como en el registro). */
  embeddingFloat16Bytes: Uint8Array;
}

/** Clase lista para comparar: ejemplos decodificados y normalizados (norma 1). */
export interface PreparedCustomClass {
  classId: number;
  name: string;
  isBackground: boolean;
  normalizedExamples: Float32Array[];
}

// --- Vectores ---

/** Copia normalizada a norma 1. Un vector nulo se queda nulo (similitud 0 con todo). */
export function normalizeEmbedding(values: ArrayLike<number>): Float32Array {
  let squaredNorm = 0;
  for (let valueIndex = 0; valueIndex < values.length; valueIndex++) squaredNorm += values[valueIndex]! * values[valueIndex]!;
  const normalizedValues = new Float32Array(values.length);
  if (!(squaredNorm > 0) || !Number.isFinite(squaredNorm)) return normalizedValues;
  const inverseNorm = 1 / Math.sqrt(squaredNorm);
  for (let valueIndex = 0; valueIndex < values.length; valueIndex++) normalizedValues[valueIndex] = values[valueIndex]! * inverseNorm;
  return normalizedValues;
}

/** Producto escalar; con vectores normalizados es la similitud coseno. Longitudes distintas: 0. */
export function dotProduct(leftValues: ArrayLike<number>, rightValues: ArrayLike<number>): number {
  if (leftValues.length !== rightValues.length) return 0;
  let productSum = 0;
  for (let valueIndex = 0; valueIndex < leftValues.length; valueIndex++) productSum += leftValues[valueIndex]! * rightValues[valueIndex]!;
  return productSum;
}

export function cosineSimilarity(leftValues: ArrayLike<number>, rightValues: ArrayLike<number>): number {
  return dotProduct(normalizeEmbedding(leftValues), normalizeEmbedding(rightValues));
}

/** Media de los `exampleCount` ejemplos más parecidos (o de todos, si hay menos). */
export function classSimilarity(
  normalizedEmbedding: Float32Array,
  normalizedExamples: readonly Float32Array[],
  exampleCount: number = topExampleCount,
): number {
  if (normalizedExamples.length === 0) return 0;
  const exampleSimilarities = normalizedExamples
    .map((normalizedExample) => dotProduct(normalizedEmbedding, normalizedExample))
    .sort((left, right) => right - left)
    .slice(0, Math.max(1, exampleCount));
  return exampleSimilarities.reduce((similaritySum, similarity) => similaritySum + similarity, 0) / exampleSimilarities.length;
}

/** Agrupa los ejemplos por clase, decodifica el float16 y normaliza. Se hace al cambiar las clases, no en cada ventana. */
export function prepareCustomClasses(
  customClasses: readonly CustomSoundClass[],
  examples: readonly CustomSoundExample[],
): PreparedCustomClass[] {
  return customClasses.map((customClass) => ({
    classId: customClass.id,
    name: customClass.name,
    isBackground: customClass.isBackground,
    normalizedExamples: examples
      .filter((example) => example.classId === customClass.id)
      .map((example) => normalizeEmbedding(decodeFloat16LittleEndian(example.embeddingFloat16Bytes))),
  }));
}

// --- Decisión ---

export interface CustomClassMatch {
  classId: number;
  name: string;
  similarity: number;
  /** Llega al umbral y se parece más a la clase que al fondo. */
  isMatch: boolean;
  /** Llegaba al umbral, pero el fondo se parece todavía más. */
  isBeatenByBackground: boolean;
}

export interface CustomMatchingResult {
  /** Clases con ejemplos suficientes, de más a menos parecida. */
  classMatches: CustomClassMatch[];
  /** Similitud con el fondo más parecido, o `null` si no hay ejemplos de fondo. */
  backgroundSimilarity: number | null;
}

/**
 * Compara el embedding de una ventana con las clases propias. Las clases con menos de
 * `minimumExamplesForMatching` ejemplos no se tienen en cuenta.
 */
export function matchCustomClasses(
  embedding: ArrayLike<number>,
  preparedClasses: readonly PreparedCustomClass[],
  similarityThreshold: number = defaultSimilarityThreshold,
): CustomMatchingResult {
  const normalizedEmbedding = normalizeEmbedding(embedding);
  let backgroundSimilarity: number | null = null;
  for (const preparedClass of preparedClasses) {
    if (!preparedClass.isBackground || preparedClass.normalizedExamples.length === 0) continue;
    const similarity = classSimilarity(normalizedEmbedding, preparedClass.normalizedExamples);
    backgroundSimilarity = backgroundSimilarity === null ? similarity : Math.max(backgroundSimilarity, similarity);
  }
  const classMatches = preparedClasses
    .filter((preparedClass) => !preparedClass.isBackground && preparedClass.normalizedExamples.length >= minimumExamplesForMatching)
    .map((preparedClass): CustomClassMatch => {
      const similarity = classSimilarity(normalizedEmbedding, preparedClass.normalizedExamples);
      const reachesThreshold = similarity >= similarityThreshold;
      const isBeatenByBackground = reachesThreshold && backgroundSimilarity !== null && backgroundSimilarity >= similarity;
      return {
        classId: preparedClass.classId,
        name: preparedClass.name,
        similarity,
        isMatch: reachesThreshold && !isBeatenByBackground,
        isBeatenByBackground,
      };
    })
    .sort((left, right) => right.similarity - left.similarity);
  return { classMatches, backgroundSimilarity };
}

/** Nombre limpio para una clase nueva o renombrada, o `null` si queda vacío. */
export function sanitizeClassName(rawName: string): string | null {
  const cleanName = rawName.replace(/\s+/g, ' ').trim().slice(0, maximumClassNameLength).trim();
  return cleanName === '' ? null : cleanName;
}

// --- Exportación (JSONL, una línea por ejemplo) ---

/** Marca de cada línea, para distinguirlas de las del registro de detecciones. */
export const customSoundExportRecordType = 'custom-sound-example';

export function formatCustomSoundsJsonLines(
  customClasses: readonly CustomSoundClass[],
  examples: readonly CustomSoundExample[],
): string {
  const classById = new Map(customClasses.map((customClass) => [customClass.id, customClass]));
  const jsonLines: string[] = [];
  for (const example of examples) {
    const customClass = classById.get(example.classId);
    if (!customClass) continue;
    jsonLines.push(
      JSON.stringify({
        type: customSoundExportRecordType,
        className: customClass.name,
        isBackground: customClass.isBackground,
        recordedAt: example.recordedAtIso,
        modelVersion: example.modelVersion,
        embedding: {
          format: embeddingExportFormat,
          dimensions: example.embeddingFloat16Bytes.length / 2,
          data: bytesToBase64(example.embeddingFloat16Bytes),
        },
      }),
    );
  }
  return jsonLines.join('\n') + (jsonLines.length > 0 ? '\n' : '');
}

export interface ImportedCustomSoundExample {
  className: string;
  isBackground: boolean;
  recordedAtIso: string;
  modelVersion: string;
  embeddingFloat16Bytes: Uint8Array;
}

/**
 * Lee un JSONL exportado (para reutilizar las clases en otro móvil o en un script). Se saltan las
 * líneas vacías, las que no son de ejemplos y las que tienen el embedding mal.
 */
export function parseCustomSoundsJsonLines(jsonLinesText: string): ImportedCustomSoundExample[] {
  const importedExamples: ImportedCustomSoundExample[] = [];
  for (const jsonLine of jsonLinesText.split(/\r?\n/)) {
    if (jsonLine.trim() === '') continue;
    try {
      const parsedLine: unknown = JSON.parse(jsonLine);
      if (typeof parsedLine !== 'object' || parsedLine === null) continue;
      const lineRecord = parsedLine as Record<string, unknown>;
      const embeddingRecord = lineRecord.embedding as Record<string, unknown> | undefined;
      if (lineRecord.type !== customSoundExportRecordType || typeof lineRecord.className !== 'string') continue;
      if (embeddingRecord?.format !== embeddingExportFormat || typeof embeddingRecord.data !== 'string') continue;
      const embeddingFloat16Bytes = base64ToBytes(embeddingRecord.data);
      if (embeddingFloat16Bytes.length === 0 || embeddingFloat16Bytes.length !== Number(embeddingRecord.dimensions) * 2) continue;
      const className = sanitizeClassName(lineRecord.className);
      if (!className) continue;
      importedExamples.push({
        className,
        isBackground: lineRecord.isBackground === true,
        recordedAtIso: typeof lineRecord.recordedAt === 'string' ? lineRecord.recordedAt : '',
        modelVersion: typeof lineRecord.modelVersion === 'string' ? lineRecord.modelVersion : '',
        embeddingFloat16Bytes,
      });
    } catch {
      // Línea que no es JSON o con base64 roto: se salta.
    }
  }
  return importedExamples;
}

/** Similitud para mostrar: «0,87». */
export function similarityText(similarity: number): string {
  return roundScore(similarity).toFixed(2).replace('.', ',');
}

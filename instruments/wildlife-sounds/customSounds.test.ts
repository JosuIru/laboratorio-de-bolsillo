import {
  classSimilarity,
  cosineSimilarity,
  type CustomSoundClass,
  type CustomSoundExample,
  defaultSimilarityThreshold,
  formatCustomSoundsJsonLines,
  matchCustomClasses,
  normalizeEmbedding,
  parseCustomSoundsJsonLines,
  prepareCustomClasses,
  sanitizeClassName,
  similarityText,
} from './customSounds';
import { encodeFloat16LittleEndian } from './detectionLog';

const embeddingDimensions = 1536;

/** Generador pseudoaleatorio con semilla (mulberry32), para que el test sea reproducible. */
function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Embeddings sintéticos parecidos a los de Perch: todos positivos y con una parte común grande
 * (por eso dos sonidos distintos ya se parecen bastante), más un perfil propio de cada clase.
 */
function createSyntheticWorld(seed: number) {
  const random = createSeededRandom(seed);
  const sharedProfile = Float32Array.from({ length: embeddingDimensions }, () => random());
  const createClassProfile = () => Float32Array.from({ length: embeddingDimensions }, () => (random() < 0.15 ? random() * 3 : 0));
  const sampleFrom = (classProfile: Float32Array, noiseAmplitude = 0.25) =>
    Float32Array.from(
      { length: embeddingDimensions },
      (_, valueIndex) => sharedProfile[valueIndex]! * 0.6 + classProfile[valueIndex]! + random() * noiseAmplitude,
    );
  return { createClassProfile, sampleFrom };
}

function exampleFrom(exampleId: number, classId: number, embedding: Float32Array): CustomSoundExample {
  return {
    id: exampleId,
    classId,
    recordedAtIso: '2026-09-26T10:00:00.000Z',
    modelVersion: 'europa-1',
    embeddingFloat16Bytes: encodeFloat16LittleEndian(embedding),
  };
}

const dogClass: CustomSoundClass = { id: 1, name: 'Mi perro', isBackground: false, createdAtIso: '2026-09-26T10:00:00.000Z' };
const doorClass: CustomSoundClass = { id: 2, name: 'La puerta', isBackground: false, createdAtIso: '2026-09-26T10:00:00.000Z' };
const backgroundClass: CustomSoundClass = { id: 3, name: 'Fondo', isBackground: true, createdAtIso: '2026-09-26T10:00:00.000Z' };

describe('similitud coseno', () => {
  it('vale 1 con vectores proporcionales, 0 con ortogonales y con el vector nulo', () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 5])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1, 6);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('la similitud de clase es la media de los ejemplos más parecidos', () => {
    const query = normalizeEmbedding([1, 0]);
    const examples = [normalizeEmbedding([1, 0]), normalizeEmbedding([0, 1]), normalizeEmbedding([1, 1])];
    expect(classSimilarity(query, examples, 2)).toBeCloseTo((1 + Math.SQRT1_2) / 2, 6);
    expect(classSimilarity(query, examples, 1)).toBeCloseTo(1, 6);
    expect(classSimilarity(query, [], 2)).toBe(0);
  });
});

describe('matchCustomClasses con vectores sintéticos', () => {
  const { createClassProfile, sampleFrom } = createSyntheticWorld(2026);
  const dogProfile = createClassProfile();
  const doorProfile = createClassProfile();
  const examples: CustomSoundExample[] = [];
  let nextExampleId = 1;
  for (let exampleIndex = 0; exampleIndex < 4; exampleIndex++) {
    examples.push(exampleFrom(nextExampleId++, dogClass.id, sampleFrom(dogProfile)));
    examples.push(exampleFrom(nextExampleId++, doorClass.id, sampleFrom(doorProfile)));
  }
  const preparedClasses = prepareCustomClasses([dogClass, doorClass], examples);

  it('separa las dos clases: cada sonido nuevo solo coincide con la suya', () => {
    for (let trialIndex = 0; trialIndex < 5; trialIndex++) {
      const dogResult = matchCustomClasses(sampleFrom(dogProfile), preparedClasses);
      expect(dogResult.classMatches[0]!.name).toBe('Mi perro');
      expect(dogResult.classMatches[0]!.isMatch).toBe(true);
      expect(dogResult.classMatches[1]!.isMatch).toBe(false);

      const doorResult = matchCustomClasses(sampleFrom(doorProfile), preparedClasses);
      expect(doorResult.classMatches.map((classMatch) => classMatch.isMatch)).toEqual([true, false]);
      expect(doorResult.classMatches[0]!.name).toBe('La puerta');
    }
  });

  it('un sonido que no es de ninguna clase no coincide, aunque comparta la parte común', () => {
    const unrelatedResult = matchCustomClasses(sampleFrom(createClassProfile()), preparedClasses);
    expect(unrelatedResult.classMatches.every((classMatch) => !classMatch.isMatch)).toBe(true);
    expect(unrelatedResult.classMatches[0]!.similarity).toBeLessThan(defaultSimilarityThreshold);
    expect(unrelatedResult.backgroundSimilarity).toBeNull();
  });

  it('el umbral controla la sensibilidad', () => {
    const dogSample = sampleFrom(dogProfile);
    expect(matchCustomClasses(dogSample, preparedClasses, 0.999).classMatches[0]!.isMatch).toBe(false);
    expect(matchCustomClasses(dogSample, preparedClasses, 0.5).classMatches.every((classMatch) => classMatch.isMatch)).toBe(true);
  });

  it('los ejemplos de fondo descartan coincidencias que se parecen más al fondo', () => {
    const noisyDogProfile = dogProfile.map((profileValue) => profileValue * 0.3);
    const backgroundExamples = [0, 1, 2].map((exampleIndex) =>
      exampleFrom(100 + exampleIndex, backgroundClass.id, sampleFrom(noisyDogProfile)),
    );
    const withBackground = prepareCustomClasses([dogClass, doorClass, backgroundClass], [...examples, ...backgroundExamples]);
    const faintDogResult = matchCustomClasses(sampleFrom(noisyDogProfile), withBackground, 0.5);
    const dogMatch = faintDogResult.classMatches.find((classMatch) => classMatch.name === 'Mi perro')!;
    expect(faintDogResult.backgroundSimilarity).not.toBeNull();
    expect(dogMatch.isMatch).toBe(false);
    expect(dogMatch.isBeatenByBackground).toBe(true);
    // El fondo no aparece como clase reconocible.
    expect(faintDogResult.classMatches.map((classMatch) => classMatch.name)).not.toContain('Fondo');
  });

  it('no usa clases con menos de 3 ejemplos', () => {
    const fewExamples = prepareCustomClasses([dogClass], examples.filter((example) => example.classId === dogClass.id).slice(0, 2));
    expect(matchCustomClasses(sampleFrom(dogProfile), fewExamples).classMatches).toEqual([]);
  });
});

describe('nombres', () => {
  it('limpia espacios y rechaza nombres vacíos', () => {
    expect(sanitizeClassName('  Mi   perro ')).toBe('Mi perro');
    expect(sanitizeClassName('   ')).toBeNull();
    expect(sanitizeClassName('x'.repeat(100))).toHaveLength(40);
  });

  it('formatea la similitud con coma decimal', () => {
    expect(similarityText(0.8712)).toBe('0,87');
  });
});

describe('exportación JSONL', () => {
  const examples = [
    exampleFrom(1, dogClass.id, Float32Array.from([1, 0.5, -2])),
    exampleFrom(2, backgroundClass.id, Float32Array.from([0, 0, 1])),
    // Ejemplo de una clase que ya no existe: no se exporta.
    exampleFrom(3, 99, Float32Array.from([1, 1, 1])),
  ];

  it('una línea por ejemplo, con el nombre de la clase y el embedding, y se puede volver a leer', () => {
    const jsonLinesText = formatCustomSoundsJsonLines([dogClass, backgroundClass], examples);
    const jsonLines = jsonLinesText.trimEnd().split('\n');
    expect(jsonLines).toHaveLength(2);
    expect(JSON.parse(jsonLines[0]!)).toEqual({
      type: 'custom-sound-example',
      className: 'Mi perro',
      isBackground: false,
      recordedAt: '2026-09-26T10:00:00.000Z',
      modelVersion: 'europa-1',
      embedding: { format: 'float16-le-base64', dimensions: 3, data: expect.any(String) },
    });
    const importedExamples = parseCustomSoundsJsonLines(`${jsonLinesText}\nbasura\n{"type":"otro"}\n`);
    expect(importedExamples).toHaveLength(2);
    expect(importedExamples[1]!.isBackground).toBe(true);
    expect(Array.from(importedExamples[0]!.embeddingFloat16Bytes)).toEqual(Array.from(examples[0]!.embeddingFloat16Bytes));
    expect(formatCustomSoundsJsonLines([], [])).toBe('');
  });
});

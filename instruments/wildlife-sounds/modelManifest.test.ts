import { ManifestFormatError, parseFaunaManifest, resolveModelOutputIndices } from './modelManifest';

const validManifest = {
  formatVersion: 1,
  modelVersion: 'europa-1',
  modelFile: 'perch_europe_fp16.tflite',
  modelBytes: 37215308,
  modelSha256: '4917A179600929B4C28E36CF2F8411105ED054E99A4CE97862203EF8C3A64BA7',
  sampleRateHz: 32000,
  windowSamples: 160000,
  outputs: { embedding: 0, spatialEmbedding: 1, spectrogram: 2, logits: 3 },
  license: 'Apache-2.0 (Google Perch 2.0)',
  classes: [
    { label: 'Turdus merula', kind: 'species', group: 'bird', names: { es: 'Mirlo común', eu: 'Zozoa', en: 'Blackbird' } },
    { label: 'Speech', kind: 'sound', names: { es: 'Habla', eu: 'Hizketa', en: '' }, isHumanVoice: true },
    { label: 'Wind', kind: 'sound', names: { es: 'Viento', eu: null, en: 'Wind' } },
  ],
};

describe('parseFaunaManifest', () => {
  it('lee un manifiesto válido y normaliza el hash y los nombres vacíos', () => {
    const manifest = parseFaunaManifest(validManifest);
    expect(manifest.modelSha256).toBe(validManifest.modelSha256.toLowerCase());
    expect(manifest.classes).toHaveLength(3);
    expect(manifest.classes[0]).toEqual({
      label: 'Turdus merula',
      kind: 'species',
      group: 'bird',
      names: { es: 'Mirlo común', eu: 'Zozoa', en: 'Blackbird' },
    });
    expect(manifest.classes[1]!.isHumanVoice).toBe(true);
    expect(manifest.classes[1]!.names.en).toBeNull();
    expect(manifest.classes[2]!.isHumanVoice).toBeUndefined();
  });

  it('rechaza formatos desconocidos, hashes raros y nombres de fichero peligrosos', () => {
    expect(() => parseFaunaManifest({ ...validManifest, formatVersion: 2 })).toThrow(ManifestFormatError);
    expect(() => parseFaunaManifest({ ...validManifest, modelSha256: 'abc' })).toThrow(ManifestFormatError);
    expect(() => parseFaunaManifest({ ...validManifest, modelFile: '../../x.tflite' })).toThrow(ManifestFormatError);
    expect(() => parseFaunaManifest({ ...validManifest, classes: [] })).toThrow(ManifestFormatError);
    expect(() => parseFaunaManifest(null)).toThrow(ManifestFormatError);
  });
});

describe('resolveModelOutputIndices', () => {
  const manifest = parseFaunaManifest(validManifest);

  it('reconoce las salidas por su forma aunque vengan en otro orden', () => {
    expect(
      resolveModelOutputIndices(
        [{ shape: [1, 3] }, { shape: [1, 500, 128] }, { shape: [1, 1536] }, { shape: [1, 16, 4, 1536] }],
        manifest,
      ),
    ).toEqual({ logits: 0, spectrogram: 1, embedding: 2, spatialEmbedding: 3 });
  });

  it('si las formas no bastan, usa el orden del manifiesto', () => {
    expect(
      resolveModelOutputIndices([{ shape: [1, 1536] }, { shape: [1, 1536] }, { shape: [1, 5] }, { shape: [1, 3] }], manifest),
    ).toEqual(validManifest.outputs);
  });

  it('falla si los logits no tienen tantas clases como el manifiesto', () => {
    expect(() => resolveModelOutputIndices([{ shape: [1, 7] }], manifest)).toThrow(ManifestFormatError);
  });
});

import { defineMeasurementSchema, MeasurementValidationError } from './schema';

const exampleSchema = defineMeasurementSchema<{
  dominantFrequencyHz: number;
  label: string;
  spectrum: number[];
  sampleColor?: string;
}>(1, [
  { key: 'dominantFrequencyHz', labelKey: 'fields.frequency', type: 'number', unit: 'Hz' },
  { key: 'label', labelKey: 'fields.label', type: 'string' },
  { key: 'spectrum', labelKey: 'fields.spectrum', type: 'numberArray' },
  { key: 'sampleColor', labelKey: 'fields.color', type: 'color', optional: true },
]);

describe('defineMeasurementSchema', () => {
  it('acepta valores válidos, descarta campos no declarados y convierte arrays tipados', () => {
    const validatedValues = exampleSchema.validate({
      dominantFrequencyHz: 440,
      label: 'La',
      spectrum: new Float32Array([0.5, 1]),
      undeclaredField: 'se descarta',
    });
    expect(validatedValues).toEqual({ dominantFrequencyHz: 440, label: 'La', spectrum: [0.5, 1] });
    expect(Array.isArray(validatedValues.spectrum)).toBe(true);
  });

  it('permite omitir los campos opcionales pero valida su tipo si están', () => {
    const baseValues = { dominantFrequencyHz: 1, label: '', spectrum: [] };
    expect(() => exampleSchema.validate(baseValues)).not.toThrow();
    expect(exampleSchema.validate({ ...baseValues, sampleColor: '#A1b2C3' }).sampleColor).toBe('#A1b2C3');
    expect(() => exampleSchema.validate({ ...baseValues, sampleColor: 'rojo' })).toThrow(MeasurementValidationError);
  });

  it.each([
    ['falta un campo obligatorio', { label: 'x', spectrum: [] }, 'dominantFrequencyHz'],
    ['número no finito', { dominantFrequencyHz: NaN, label: 'x', spectrum: [] }, 'dominantFrequencyHz'],
    ['array con no números', { dominantFrequencyHz: 1, label: 'x', spectrum: [1, 'a'] }, 'spectrum'],
    ['tipo incorrecto', { dominantFrequencyHz: 1, label: 3, spectrum: [] }, 'label'],
  ])('rechaza: %s', (_description, invalidValues, expectedFieldKey) => {
    expect(() => exampleSchema.validate(invalidValues)).toThrow(
      expect.objectContaining({ fieldKey: expectedFieldKey }),
    );
  });

  it('rechaza valores que no son un objeto', () => {
    expect(() => exampleSchema.validate(null)).toThrow(MeasurementValidationError);
    expect(() => exampleSchema.validate([1, 2])).toThrow(MeasurementValidationError);
  });
});

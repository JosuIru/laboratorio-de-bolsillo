import es from './locales/es.json';
import eu from './locales/eu.json';

function collectKeyPaths(translationTree: object, parentPath = ''): string[] {
  return Object.entries(translationTree).flatMap(([key, value]) => {
    const keyPath = parentPath ? `${parentPath}.${key}` : key;
    return typeof value === 'object' && value !== null
      ? collectKeyPaths(value as object, keyPath)
      : [keyPath];
  });
}

describe('traducciones del núcleo', () => {
  it('castellano y euskera tienen exactamente las mismas claves', () => {
    expect(collectKeyPaths(eu).sort()).toEqual(collectKeyPaths(es).sort());
  });

  it('no hay textos vacíos', () => {
    for (const translations of [es, eu]) {
      const emptyKeyPaths = collectKeyPaths(translations).filter((keyPath) => {
        const translatedText = keyPath
          .split('.')
          .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], translations);
        return typeof translatedText !== 'string' || translatedText.trim() === '';
      });
      expect(emptyKeyPaths).toEqual([]);
    }
  });
});

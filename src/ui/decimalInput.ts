/** Número escrito por el usuario, con coma o punto decimal («65,5» o «65.5»). */
export function parseDecimalInput(inputText: string): number | null {
  const normalizedText = inputText.trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(normalizedText)) return null;
  return Number(normalizedText);
}

import { euroCoinMassesGrams } from '@/processing/resonanceScale/massCalibration';

/** Si la amplitud varía más que esto entre pulsos, algo se ha movido durante la medida. */
export const irregularPulseSpreadThreshold = 0.1;

/** Un folio A4 de 80 g/m² pesa 0,0625 m² × 80 g/m² = 5 g. */
export const a4SheetMassGrams = 5;

/** Gramos con una cifra decimal por debajo de 10 g y sin decimales por encima. */
export function formatGrams(massGrams: number): string {
  const roundedMass = Math.abs(massGrams) < 10 ? Math.round(massGrams * 10) / 10 : Math.round(massGrams);
  // Evita «-0».
  return (roundedMass === 0 ? 0 : roundedMass).toLocaleString();
}

export interface FunEquivalences {
  oneEuroCoins: number;
  a4Sheets: number;
}

/** Comparaciones para hacerse una idea (redondeadas a medias unidades). */
export function funEquivalences(massGrams: number): FunEquivalences | null {
  if (!(massGrams > 0)) return null;
  const roundToHalf = (quantity: number) => Math.round(quantity * 2) / 2;
  return {
    oneEuroCoins: roundToHalf(massGrams / euroCoinMassesGrams.oneEuro),
    a4Sheets: roundToHalf(massGrams / a4SheetMassGrams),
  };
}

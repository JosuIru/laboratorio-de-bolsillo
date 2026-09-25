/**
 * Ajuste por mínimos cuadrados de las bandas de parpadeo en un perfil de luminancia:
 *
 *   perfil(x) ≈ fondo(x) + Σₖ Aₖ · cos(2π·k·ν·x + θₖ),   x = índice − centro
 *
 * donde `fondo` es un polinomio de grado bajo (la escena, el viñeteado) y ν la frecuencia
 * espacial de las bandas en ciclos por muestra. Las fases se refieren a la muestra central, así
 * que un error pequeño en ν apenas las cambia: eso es lo que permite seguir la deriva de fase
 * entre fotogramas sin conocer con exactitud el tiempo de lectura por fila.
 */

export interface BandFitOptions {
  /** Frecuencia espacial de la fundamental, en ciclos por muestra del perfil. */
  spatialFrequency: number;
  /** Armónicos que se ajustan (1 = solo la fundamental). Los que pasan de Nyquist se omiten. */
  harmonicCount: number;
  /** Grado del polinomio de fondo (0, 1 o 2). */
  backgroundDegree: number;
}

export interface BandFit {
  /** Nivel medio del perfil (término constante del fondo). */
  meanLevel: number;
  /** Amplitud de cada armónico, relativa a `meanLevel` (0,1 = 10 %). */
  relativeAmplitudes: number[];
  /** Fase de cada armónico en la muestra central, en radianes. */
  phases: number[];
  /** Raíz cuadrática media del residuo, relativa a `meanLevel`. */
  relativeResidualRms: number;
  /** Coeficientes del polinomio de fondo, en la posición normalizada (x / (longitud/2)). */
  backgroundCoefficients: number[];
}

/** Armónicos por debajo de este múltiplo de Nyquist (0,5 ciclos/muestra) se pueden ajustar. */
const maximumFittedSpatialFrequency = 0.45;

/**
 * Resuelve `matrix · solution = rightHandSide` (matriz cuadrada `size`×`size`, por filas) por
 * eliminación gaussiana con pivoteo parcial. Devuelve null si el sistema es singular.
 */
export function solveLinearSystem(matrix: Float64Array, rightHandSide: Float64Array, size: number): Float64Array | null {
  const workingMatrix = Float64Array.from(matrix);
  const solution = Float64Array.from(rightHandSide);
  for (let pivotColumn = 0; pivotColumn < size; pivotColumn++) {
    let pivotRow = pivotColumn;
    let largestMagnitude = Math.abs(workingMatrix[pivotColumn * size + pivotColumn]!);
    for (let candidateRow = pivotColumn + 1; candidateRow < size; candidateRow++) {
      const candidateMagnitude = Math.abs(workingMatrix[candidateRow * size + pivotColumn]!);
      if (candidateMagnitude > largestMagnitude) {
        largestMagnitude = candidateMagnitude;
        pivotRow = candidateRow;
      }
    }
    if (largestMagnitude < 1e-12) return null;
    if (pivotRow !== pivotColumn) {
      for (let columnIndex = 0; columnIndex < size; columnIndex++) {
        const temporary = workingMatrix[pivotColumn * size + columnIndex]!;
        workingMatrix[pivotColumn * size + columnIndex] = workingMatrix[pivotRow * size + columnIndex]!;
        workingMatrix[pivotRow * size + columnIndex] = temporary;
      }
      const temporaryRightHandSide = solution[pivotColumn]!;
      solution[pivotColumn] = solution[pivotRow]!;
      solution[pivotRow] = temporaryRightHandSide;
    }
    const pivotValue = workingMatrix[pivotColumn * size + pivotColumn]!;
    for (let eliminatedRow = pivotColumn + 1; eliminatedRow < size; eliminatedRow++) {
      const eliminationFactor = workingMatrix[eliminatedRow * size + pivotColumn]! / pivotValue;
      if (eliminationFactor === 0) continue;
      for (let columnIndex = pivotColumn; columnIndex < size; columnIndex++) {
        workingMatrix[eliminatedRow * size + columnIndex] =
          workingMatrix[eliminatedRow * size + columnIndex]! -
          eliminationFactor * workingMatrix[pivotColumn * size + columnIndex]!;
      }
      solution[eliminatedRow] = solution[eliminatedRow]! - eliminationFactor * solution[pivotColumn]!;
    }
  }
  for (let rowIndex = size - 1; rowIndex >= 0; rowIndex--) {
    let accumulatedValue = solution[rowIndex]!;
    for (let columnIndex = rowIndex + 1; columnIndex < size; columnIndex++) {
      accumulatedValue -= workingMatrix[rowIndex * size + columnIndex]! * solution[columnIndex]!;
    }
    solution[rowIndex] = accumulatedValue / workingMatrix[rowIndex * size + rowIndex]!;
  }
  return solution;
}

function usableHarmonicCount(options: BandFitOptions): number {
  let harmonicCount = 0;
  for (let harmonicNumber = 1; harmonicNumber <= options.harmonicCount; harmonicNumber++) {
    if (harmonicNumber * options.spatialFrequency <= maximumFittedSpatialFrequency) harmonicCount = harmonicNumber;
  }
  return harmonicCount;
}

export interface BandFitter {
  /** Ajusta fondo y bandas a un perfil de la longitud del ajustador (null si no se puede). */
  fit(profile: ArrayLike<number>): BandFit | null;
}

/**
 * Prepara un ajustador para una longitud de perfil y unas opciones: calcula una vez la base
 * (polinomio, cosenos y senos) y la inversa de su matriz normal, de modo que ajustar cada perfil
 * cuesta solo unos productos. Devuelve null si el perfil es demasiado corto o la base, singular.
 */
export function createBandFitter(profileLength: number, options: BandFitOptions): BandFitter | null {
  const harmonicCount = usableHarmonicCount(options);
  const backgroundDegree = Math.max(0, Math.min(2, Math.round(options.backgroundDegree)));
  const parameterCount = backgroundDegree + 1 + 2 * harmonicCount;
  if (harmonicCount === 0 || profileLength < 2 * parameterCount) return null;

  // Base por filas: basisMatrix[muestra · parámetros + parámetro].
  const basisMatrix = new Float64Array(profileLength * parameterCount);
  for (let sampleIndex = 0; sampleIndex < profileLength; sampleIndex++) {
    const centeredPosition = sampleIndex - (profileLength - 1) / 2;
    const normalizedPosition = centeredPosition / (profileLength / 2);
    const rowStart = sampleIndex * parameterCount;
    let polynomialValue = 1;
    for (let degree = 0; degree <= backgroundDegree; degree++) {
      basisMatrix[rowStart + degree] = polynomialValue;
      polynomialValue *= normalizedPosition;
    }
    for (let harmonicNumber = 1; harmonicNumber <= harmonicCount; harmonicNumber++) {
      const angle = 2 * Math.PI * harmonicNumber * options.spatialFrequency * centeredPosition;
      const basisOffset = rowStart + backgroundDegree + 1 + 2 * (harmonicNumber - 1);
      basisMatrix[basisOffset] = Math.cos(angle);
      basisMatrix[basisOffset + 1] = Math.sin(angle);
    }
  }

  const normalMatrix = new Float64Array(parameterCount * parameterCount);
  for (let sampleIndex = 0; sampleIndex < profileLength; sampleIndex++) {
    const rowStart = sampleIndex * parameterCount;
    for (let rowIndex = 0; rowIndex < parameterCount; rowIndex++) {
      const rowBasisValue = basisMatrix[rowStart + rowIndex]!;
      for (let columnIndex = 0; columnIndex < parameterCount; columnIndex++) {
        normalMatrix[rowIndex * parameterCount + columnIndex] =
          normalMatrix[rowIndex * parameterCount + columnIndex]! + rowBasisValue * basisMatrix[rowStart + columnIndex]!;
      }
    }
  }
  // Pseudoinversa (BᵀB)⁻¹Bᵀ, columna a columna de la identidad.
  const inverseNormalMatrix = new Float64Array(parameterCount * parameterCount);
  const unitVector = new Float64Array(parameterCount);
  for (let columnIndex = 0; columnIndex < parameterCount; columnIndex++) {
    unitVector.fill(0);
    unitVector[columnIndex] = 1;
    const inverseColumn = solveLinearSystem(normalMatrix, unitVector, parameterCount);
    if (!inverseColumn) return null;
    for (let rowIndex = 0; rowIndex < parameterCount; rowIndex++) {
      inverseNormalMatrix[rowIndex * parameterCount + columnIndex] = inverseColumn[rowIndex]!;
    }
  }
  const pseudoInverse = new Float64Array(parameterCount * profileLength);
  for (let parameterIndex = 0; parameterIndex < parameterCount; parameterIndex++) {
    for (let sampleIndex = 0; sampleIndex < profileLength; sampleIndex++) {
      let pseudoInverseValue = 0;
      for (let innerIndex = 0; innerIndex < parameterCount; innerIndex++) {
        pseudoInverseValue +=
          inverseNormalMatrix[parameterIndex * parameterCount + innerIndex]! *
          basisMatrix[sampleIndex * parameterCount + innerIndex]!;
      }
      pseudoInverse[parameterIndex * profileLength + sampleIndex] = pseudoInverseValue;
    }
  }
  const degreesOfFreedom = Math.max(1, profileLength - parameterCount);
  const coefficients = new Float64Array(parameterCount);

  function fit(profile: ArrayLike<number>): BandFit | null {
    if (profile.length !== profileLength) return null;
    for (let parameterIndex = 0; parameterIndex < parameterCount; parameterIndex++) {
      let coefficientValue = 0;
      const pseudoInverseRowStart = parameterIndex * profileLength;
      for (let sampleIndex = 0; sampleIndex < profileLength; sampleIndex++) {
        coefficientValue += pseudoInverse[pseudoInverseRowStart + sampleIndex]! * profile[sampleIndex]!;
      }
      coefficients[parameterIndex] = coefficientValue;
    }
    const meanLevel = coefficients[0]!;
    if (!(meanLevel > 0)) return null;

    const relativeAmplitudes: number[] = [];
    const phases: number[] = [];
    for (let harmonicNumber = 1; harmonicNumber <= harmonicCount; harmonicNumber++) {
      const basisOffset = backgroundDegree + 1 + 2 * (harmonicNumber - 1);
      const cosineCoefficient = coefficients[basisOffset]!;
      const sineCoefficient = coefficients[basisOffset + 1]!;
      // a·cos(φ) + b·sin(φ) = A·cos(φ + θ) con A = √(a²+b²) y θ = atan2(−b, a).
      relativeAmplitudes.push(Math.hypot(cosineCoefficient, sineCoefficient) / meanLevel);
      phases.push(Math.atan2(-sineCoefficient, cosineCoefficient));
    }

    let squaredResidualSum = 0;
    for (let sampleIndex = 0; sampleIndex < profileLength; sampleIndex++) {
      const rowStart = sampleIndex * parameterCount;
      let modelValue = 0;
      for (let parameterIndex = 0; parameterIndex < parameterCount; parameterIndex++) {
        modelValue += coefficients[parameterIndex]! * basisMatrix[rowStart + parameterIndex]!;
      }
      const residual = profile[sampleIndex]! - modelValue;
      squaredResidualSum += residual * residual;
    }
    return {
      meanLevel,
      relativeAmplitudes,
      phases,
      relativeResidualRms: Math.sqrt(squaredResidualSum / degreesOfFreedom) / meanLevel,
      backgroundCoefficients: Array.from(coefficients.subarray(0, backgroundDegree + 1)),
    };
  }

  return { fit };
}

/**
 * Ajusta fondo y bandas a un perfil. Devuelve null si el perfil es demasiado corto, el nivel
 * medio no es positivo o el sistema es singular. Para muchos perfiles, `createBandFitter`.
 */
export function fitBandedProfile(profile: ArrayLike<number>, options: BandFitOptions): BandFit | null {
  return createBandFitter(profile.length, options)?.fit(profile) ?? null;
}

/**
 * Evalúa las bandas ajustadas (sin el fondo), relativas al nivel medio, en cada muestra.
 * Sirve para dibujar el ajuste encima del perfil medido.
 */
export function evaluateBandModel(fit: BandFit, spatialFrequency: number, profileLength: number): Float64Array {
  const modelValues = new Float64Array(profileLength);
  for (let sampleIndex = 0; sampleIndex < profileLength; sampleIndex++) {
    const centeredPosition = sampleIndex - (profileLength - 1) / 2;
    let bandValue = 0;
    for (let harmonicIndex = 0; harmonicIndex < fit.relativeAmplitudes.length; harmonicIndex++) {
      bandValue +=
        fit.relativeAmplitudes[harmonicIndex]! *
        Math.cos(2 * Math.PI * (harmonicIndex + 1) * spatialFrequency * centeredPosition + fit.phases[harmonicIndex]!);
    }
    modelValues[sampleIndex] = bandValue;
  }
  return modelValues;
}

/**
 * El perfil medido sin el fondo, relativo al nivel medio: (perfil − fondo) / nivel medio. Es lo
 * que se dibuja como «bandas medidas».
 */
export function removeFittedBackground(profile: ArrayLike<number>, fit: BandFit): Float64Array {
  const profileLength = profile.length;
  const modulationValues = new Float64Array(profileLength);
  for (let sampleIndex = 0; sampleIndex < profileLength; sampleIndex++) {
    const normalizedPosition = (sampleIndex - (profileLength - 1) / 2) / (profileLength / 2);
    let backgroundValue = 0;
    let polynomialValue = 1;
    for (const backgroundCoefficient of fit.backgroundCoefficients) {
      backgroundValue += backgroundCoefficient * polynomialValue;
      polynomialValue *= normalizedPosition;
    }
    modulationValues[sampleIndex] = (profile[sampleIndex]! - backgroundValue) / fit.meanLevel;
  }
  return modulationValues;
}

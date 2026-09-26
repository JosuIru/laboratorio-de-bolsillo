import {
  advanceExposureSearch,
  brightnessReadingFromLinearMean,
  type ExposureSearchState,
  initialManualExposure,
  type ManualExposure,
  type ManualExposureLimits,
  maximumExposureAdjustments,
  planCameraLock,
  spectrumPeakTargetBand,
  splitExposureProduct,
  startExposureSearch,
  whiteReferenceTargetBand,
} from './lockedCameraExposure';

const typicalLimits: ManualExposureLimits = {
  minimumDurationSeconds: 1 / 20000,
  maximumDurationSeconds: 0.5,
  minimumIso: 50,
  maximumIso: 3200,
};

describe('planCameraLock', () => {
  it('fija balance y exposición si el sensor da sus rangos', () => {
    const lockPlan = planCameraLock({
      supportsExposureLocking: true,
      supportsWhiteBalanceLocking: true,
      minimumDurationSeconds: typicalLimits.minimumDurationSeconds,
      maximumDurationSeconds: typicalLimits.maximumDurationSeconds,
      minimumIso: typicalLimits.minimumIso,
      maximumIso: typicalLimits.maximumIso,
    });
    expect(lockPlan).toEqual({ canLockWhiteBalance: true, exposureLimits: typicalLimits, isSupported: true });
  });

  it('sin rangos de exposición (cámara sin arrancar o sin MANUAL_SENSOR) solo fija el balance', () => {
    const lockPlan = planCameraLock({
      supportsExposureLocking: true,
      supportsWhiteBalanceLocking: true,
      minimumDurationSeconds: 0,
      maximumDurationSeconds: 0,
      minimumIso: 0,
      maximumIso: 0,
    });
    expect(lockPlan.exposureLimits).toBeNull();
    expect(lockPlan.isSupported).toBe(true);
  });

  it('sin nada que fijar, no se admite (todo sigue en automático)', () => {
    const lockPlan = planCameraLock({
      supportsExposureLocking: false,
      supportsWhiteBalanceLocking: false,
      minimumDurationSeconds: 0.0001,
      maximumDurationSeconds: 1,
      minimumIso: 100,
      maximumIso: 1600,
    });
    expect(lockPlan).toEqual({ canLockWhiteBalance: false, exposureLimits: null, isSupported: false });
  });
});

describe('splitExposureProduct', () => {
  it('con mucha luz usa ISO mínimo y tiempo corto', () => {
    const exposure = splitExposureProduct((1 / 2000) * 50, typicalLimits);
    expect(exposure.iso).toBe(50);
    expect(exposure.durationSeconds).toBeCloseTo(1 / 2000, 8);
  });

  it('con luz de interior usa múltiplos de 1/100 s y completa con el ISO', () => {
    const exposure = splitExposureProduct((1 / 50) * 200, typicalLimits);
    expect(exposure.durationSeconds).toBeCloseTo(0.03, 8);
    expect(exposure.iso).toBe(133);
    const brighterExposure = splitExposureProduct(0.015 * 50, typicalLimits);
    expect(brighterExposure.durationSeconds).toBeCloseTo(0.01, 8);
    expect(brighterExposure.iso).toBe(75);
  });

  it('con muy poca luz sube el ISO al máximo y alarga el tiempo', () => {
    const exposure = splitExposureProduct(0.2 * 3200, typicalLimits);
    expect(exposure.iso).toBe(3200);
    expect(exposure.durationSeconds).toBeCloseTo(0.2, 8);
  });

  it('respeta los límites del sensor', () => {
    expect(splitExposureProduct(1e-9, typicalLimits)).toEqual({ durationSeconds: 1 / 20000, iso: 50 });
    expect(splitExposureProduct(1e6, typicalLimits)).toEqual({ durationSeconds: 0.5, iso: 3200 });
  });
});

describe('initialManualExposure', () => {
  it('parte de la exposición que informa la cámara si la hay', () => {
    const exposure = initialManualExposure({ durationSeconds: 1 / 1000, iso: 100 }, typicalLimits);
    expect(exposure.durationSeconds * exposure.iso).toBeCloseTo(0.1, 6);
  });

  it('sin información (Android en automático) parte de 1/50 s a ISO 200', () => {
    const exposure = initialManualExposure({ durationSeconds: 0, iso: 0 }, typicalLimits);
    expect(exposure.durationSeconds * exposure.iso).toBeCloseTo(4, 0);
  });
});

/**
 * Escena simulada: el brillo lineal es proporcional a tiempo × ISO; `saturatedFraction` sale de un
 * pico que satura antes que la media (como una línea del espectro).
 */
function simulateSearch(
  brightnessPerProduct: number,
  targetBand = whiteReferenceTargetBand,
  peakToMeanRatio = 1,
  initialExposure: ManualExposure = initialManualExposure(null, typicalLimits),
): ExposureSearchState {
  let searchState = startExposureSearch(initialExposure);
  for (let stepIndex = 0; stepIndex < 30 && searchState.outcome === 'adjusting'; stepIndex++) {
    const product = searchState.exposure.durationSeconds * searchState.exposure.iso;
    const meanLinear = Math.min(1, brightnessPerProduct * product);
    const peakLinear = brightnessPerProduct * product * peakToMeanRatio;
    searchState = advanceExposureSearch(
      searchState,
      { brightestChannelLinear: meanLinear, saturatedFraction: peakLinear >= 1 ? 0.05 : 0 },
      typicalLimits,
      targetBand,
    );
  }
  return searchState;
}

describe('advanceExposureSearch', () => {
  it('converge enseguida si ya está dentro de la banda', () => {
    const searchState = advanceExposureSearch(
      startExposureSearch({ durationSeconds: 0.01, iso: 100 }),
      { brightestChannelLinear: 0.7, saturatedFraction: 0 },
      typicalLimits,
      whiteReferenceTargetBand,
    );
    expect(searchState.outcome).toBe('converged');
    expect(searchState.adjustmentCount).toBe(0);
  });

  it('en interior (poca luz) sube hasta dejar el blanco en la banda', () => {
    const searchState = simulateSearch(0.7 / ((1 / 30) * 800));
    expect(searchState.outcome).toBe('converged');
    const product = searchState.exposure.durationSeconds * searchState.exposure.iso;
    const finalLinear = (0.7 / ((1 / 30) * 800)) * product;
    expect(finalLinear).toBeGreaterThanOrEqual(whiteReferenceTargetBand.minimumLinear);
    expect(finalLinear).toBeLessThanOrEqual(whiteReferenceTargetBand.maximumLinear);
  });

  it('al sol (tarjeta quemada) baja hasta no saturar en pocos pasos', () => {
    const brightnessPerProduct = 0.7 / ((1 / 4000) * 50);
    const searchState = simulateSearch(brightnessPerProduct);
    expect(searchState.outcome).toBe('converged');
    expect(searchState.adjustmentCount).toBeLessThanOrEqual(6);
    const finalLinear = brightnessPerProduct * searchState.exposure.durationSeconds * searchState.exposure.iso;
    expect(finalLinear).toBeLessThan(whiteReferenceTargetBand.maximumLinear + 1e-9);
  });

  it('en el espectro deja el pico sin saturar aunque la media quede baja', () => {
    const brightnessPerProduct = 0.3 / 4;
    const peakToMeanRatio = 2;
    const searchState = simulateSearch(brightnessPerProduct, spectrumPeakTargetBand, peakToMeanRatio);
    expect(searchState.outcome).not.toBe('adjusting');
    const product = searchState.exposure.durationSeconds * searchState.exposure.iso;
    expect(brightnessPerProduct * product * peakToMeanRatio).toBeLessThan(1);
  });

  it('se queda en el límite del sensor si no hay luz suficiente', () => {
    const searchState = simulateSearch(1e-6);
    expect(searchState.outcome).toBe('limitReached');
    expect(searchState.exposure).toEqual({ durationSeconds: 0.5, iso: 3200 });
  });

  it('no vuelve a una exposición que ya saturó', () => {
    let searchState = startExposureSearch({ durationSeconds: 0.02, iso: 100 });
    searchState = advanceExposureSearch(
      searchState,
      { brightestChannelLinear: 0.99, saturatedFraction: 0.3 },
      typicalLimits,
      whiteReferenceTargetBand,
    );
    expect(searchState.saturatingProduct).toBeCloseTo(2, 6);
    searchState = advanceExposureSearch(
      searchState,
      { brightestChannelLinear: 0.1, saturatedFraction: 0 },
      typicalLimits,
      whiteReferenceTargetBand,
    );
    const product = searchState.exposure.durationSeconds * searchState.exposure.iso;
    expect(product).toBeLessThan(2);
  });

  it('se rinde tras el máximo de intentos sin quedarse saturada', () => {
    // Escena imposible: satura con cualquier exposición por encima de la que queda oscura.
    let searchState = startExposureSearch({ durationSeconds: 0.01, iso: 100 });
    for (let stepIndex = 0; stepIndex < 40 && searchState.outcome === 'adjusting'; stepIndex++) {
      const product = searchState.exposure.durationSeconds * searchState.exposure.iso;
      const isAboveThreshold = product > 0.5;
      searchState = advanceExposureSearch(
        searchState,
        isAboveThreshold
          ? { brightestChannelLinear: 0.99, saturatedFraction: 0.2 }
          : { brightestChannelLinear: 0.2, saturatedFraction: 0 },
        typicalLimits,
        whiteReferenceTargetBand,
      );
    }
    expect(['gaveUp', 'limitReached']).toContain(searchState.outcome);
    expect(searchState.adjustmentCount).toBeLessThanOrEqual(maximumExposureAdjustments);
    expect(searchState.exposure.durationSeconds * searchState.exposure.iso).toBeLessThanOrEqual(0.5 + 1e-9);
  });
});

describe('brightnessReadingFromLinearMean', () => {
  it('toma el canal más brillante', () => {
    expect(brightnessReadingFromLinearMean({ red: 0.2, green: 0.6, blue: 0.4 })).toEqual({
      brightestChannelLinear: 0.6,
      saturatedFraction: 0,
    });
  });
});

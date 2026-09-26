import { planHandheldBurstExposure } from './burstExposure';

const exposureLimits = {
  minimumExposureSeconds: 1 / 10000,
  maximumExposureSeconds: 0.5,
  minimumIso: 100,
  maximumIso: 3200,
};

describe('exposición para la ráfaga a mano', () => {
  it('con buena luz acorta el tiempo hasta 1/250 s subiendo el ISO en la misma proporción', () => {
    const exposurePlan = planHandheldBurstExposure({ exposureSeconds: 1 / 60, iso: 100 }, exposureLimits);
    expect(exposurePlan?.exposureSeconds).toBeCloseTo(1 / 250);
    expect(exposurePlan?.iso).toBe(417);
  });

  it('con poca luz se queda en el techo de ISO y acorta lo que puede', () => {
    const exposurePlan = planHandheldBurstExposure({ exposureSeconds: 1 / 15, iso: 800 }, exposureLimits);
    expect(exposurePlan?.iso).toBe(1600);
    expect(exposurePlan?.exposureSeconds).toBeCloseTo(1 / 30);
  });

  it('no toca nada si ya es corto o si el ISO ya está en el techo', () => {
    expect(planHandheldBurstExposure({ exposureSeconds: 1 / 500, iso: 100 }, exposureLimits)).toBeNull();
    expect(planHandheldBurstExposure({ exposureSeconds: 1 / 20, iso: 1600 }, exposureLimits)).toBeNull();
  });

  it('respeta el ISO máximo del sensor y no devuelve valores sin sentido', () => {
    const exposurePlan = planHandheldBurstExposure({ exposureSeconds: 1 / 30, iso: 400 }, { ...exposureLimits, maximumIso: 800 });
    expect(exposurePlan).toEqual({ exposureSeconds: 1 / 60, iso: 800 });
    expect(planHandheldBurstExposure({ exposureSeconds: 0, iso: 100 }, exposureLimits)).toBeNull();
  });
});

import { formatAccelerationSeriesCsv } from './seriesCsv';

describe('formatAccelerationSeriesCsv', () => {
  it('escribe cabecera y tiempo relativo a la primera muestra', () => {
    expect(formatAccelerationSeriesCsv([100.5, 100.51], [0.1, -0.2], [0, 0], [9.80665, 9.8])).toBe(
      'time_s,acceleration_x_m_s2,acceleration_y_m_s2,acceleration_z_m_s2\n' +
        '0.000000,0.10000,0.00000,9.80665\n' +
        '0.010000,-0.20000,0.00000,9.80000\n',
    );
  });

  it('sin muestras deja solo la cabecera', () => {
    expect(formatAccelerationSeriesCsv([], [], [], [])).toBe(
      'time_s,acceleration_x_m_s2,acceleration_y_m_s2,acceleration_z_m_s2\n',
    );
  });
});

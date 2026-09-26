import {
  clampPanelTranslation,
  collapsePanelState,
  computeCameraPanelMetrics,
  expandPanelState,
  nextPanelStateOnHandlePress,
  panelHandleHeight,
  panelPrimaryActionsHeight,
  panelTranslationForState,
  snapPanelStateAfterDrag,
} from './cameraPanelLayout';

const phonePanelMetrics = computeCameraPanelMetrics({
  screenHeight: 800,
  topInset: 24,
  bottomInset: 16,
  hasPrimaryActions: true,
});

describe('alturas del panel de la cámara a pantalla completa', () => {
  it('oculto deja ver solo el asa y asomado añade la fila de acciones, con la zona segura', () => {
    expect(phonePanelMetrics.visibleHeightByState.hidden).toBe(panelHandleHeight + 16);
    expect(phonePanelMetrics.visibleHeightByState.peek).toBe(panelHandleHeight + 16 + panelPrimaryActionsHeight);
  });

  it('abierto ocupa como mucho el 60 % de la pantalla', () => {
    expect(phonePanelMetrics.visibleHeightByState.open).toBe(480);
    expect(phonePanelMetrics.totalPanelHeight).toBe(480);
  });

  it('en pantallas bajas el panel abierto deja ver algo de imagen bajo la barra superior', () => {
    const landscapeMetrics = computeCameraPanelMetrics({
      screenHeight: 400,
      topInset: 0,
      bottomInset: 0,
      hasPrimaryActions: true,
    });
    expect(landscapeMetrics.visibleHeightByState.open).toBe(240);
    const tinyScreenMetrics = computeCameraPanelMetrics({
      screenHeight: 200,
      topInset: 0,
      bottomInset: 0,
      hasPrimaryActions: true,
    });
    // Nunca menos que asomado.
    expect(tinyScreenMetrics.visibleHeightByState.open).toBe(tinyScreenMetrics.visibleHeightByState.peek);
  });

  it('sin acciones principales, asomado equivale a oculto', () => {
    const metricsWithoutActions = computeCameraPanelMetrics({
      screenHeight: 800,
      topInset: 0,
      bottomInset: 0,
      hasPrimaryActions: false,
    });
    expect(metricsWithoutActions.visibleHeightByState.peek).toBe(metricsWithoutActions.visibleHeightByState.hidden);
  });

  it('el desplazamiento es 0 abierto y crece al plegarse', () => {
    expect(panelTranslationForState('open', phonePanelMetrics)).toBe(0);
    expect(panelTranslationForState('peek', phonePanelMetrics)).toBe(480 - 112);
    expect(panelTranslationForState('hidden', phonePanelMetrics)).toBe(480 - 48);
  });

  it('el arrastre no saca el panel de sus límites', () => {
    expect(clampPanelTranslation(-50, phonePanelMetrics)).toBe(0);
    expect(clampPanelTranslation(10_000, phonePanelMetrics)).toBe(panelTranslationForState('hidden', phonePanelMetrics));
    expect(clampPanelTranslation(100, phonePanelMetrics)).toBe(100);
  });
});

describe('ajuste del panel al soltarlo', () => {
  const peekTranslation = panelTranslationForState('peek', phonePanelMetrics);

  it('soltado despacio, va al estado más cercano', () => {
    expect(snapPanelStateAfterDrag({ releasedTranslation: peekTranslation - 20, velocityY: 0, panelMetrics: phonePanelMetrics })).toBe('peek');
    expect(snapPanelStateAfterDrag({ releasedTranslation: 30, velocityY: 0, panelMetrics: phonePanelMetrics })).toBe('open');
    expect(snapPanelStateAfterDrag({ releasedTranslation: 420, velocityY: 0, panelMetrics: phonePanelMetrics })).toBe('hidden');
  });

  it('un gesto rápido hacia arriba abre aunque se haya movido poco', () => {
    expect(
      snapPanelStateAfterDrag({ releasedTranslation: peekTranslation - 40, velocityY: -2, panelMetrics: phonePanelMetrics }),
    ).toBe('open');
  });

  it('un gesto rápido hacia abajo desde asomado lo oculta', () => {
    expect(
      snapPanelStateAfterDrag({ releasedTranslation: peekTranslation + 10, velocityY: 1, panelMetrics: phonePanelMetrics }),
    ).toBe('hidden');
  });
});

describe('toques y acciones de accesibilidad del asa', () => {
  it('un toque saca el panel oculto, abre el asomado y vuelve a asomar el abierto', () => {
    expect(nextPanelStateOnHandlePress('hidden')).toBe('peek');
    expect(nextPanelStateOnHandlePress('peek')).toBe('open');
    expect(nextPanelStateOnHandlePress('open')).toBe('peek');
  });

  it('incrementar y decrementar avanzan un paso sin pasarse', () => {
    expect(expandPanelState('hidden')).toBe('peek');
    expect(expandPanelState('peek')).toBe('open');
    expect(expandPanelState('open')).toBe('open');
    expect(collapsePanelState('open')).toBe('peek');
    expect(collapsePanelState('peek')).toBe('hidden');
    expect(collapsePanelState('hidden')).toBe('hidden');
  });
});

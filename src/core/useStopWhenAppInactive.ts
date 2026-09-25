import { useEffect, useState } from 'react';

import { useIsScreenActive } from './useIsScreenActive';

/**
 * Para un instrumento cuando la app pasa a segundo plano, cuando otra pantalla lo tapa
 * (Historial, Calibrar…) y al desmontar la pantalla.
 *
 * `resetState` se llama durante el render (el patrón que recomienda React para ajustar estado
 * cuando cambia algo): úsalo solo para volver al estado inicial. `releaseResources` se llama en
 * un efecto y es donde se cierran el audio, el micrófono, los temporizadores…
 */
export function useStopWhenAppInactive(resetState: () => void, releaseResources: () => void) {
  const isScreenActive = useIsScreenActive();
  const [wasScreenActive, setWasScreenActive] = useState(isScreenActive);
  if (wasScreenActive !== isScreenActive) {
    setWasScreenActive(isScreenActive);
    if (!isScreenActive) resetState();
  }
  useEffect(() => {
    if (!isScreenActive) releaseResources();
  }, [isScreenActive, releaseResources]);
  useEffect(() => releaseResources, [releaseResources]);
}

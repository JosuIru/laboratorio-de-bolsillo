import { useEffect, useState } from 'react';

import { useIsAppActive } from './useIsAppActive';

/**
 * Para un instrumento cuando la app pasa a segundo plano y al desmontar la pantalla.
 *
 * `resetState` se llama durante el render (el patrón que recomienda React para ajustar estado
 * cuando cambia algo): úsalo solo para volver al estado inicial. `releaseResources` se llama en
 * un efecto y es donde se cierran el audio, el micrófono, los temporizadores…
 */
export function useStopWhenAppInactive(resetState: () => void, releaseResources: () => void) {
  const isAppActive = useIsAppActive();
  const [wasAppActive, setWasAppActive] = useState(isAppActive);
  if (wasAppActive !== isAppActive) {
    setWasAppActive(isAppActive);
    if (!isAppActive) resetState();
  }
  useEffect(() => {
    if (!isAppActive) releaseResources();
  }, [isAppActive, releaseResources]);
  useEffect(() => releaseResources, [releaseResources]);
}

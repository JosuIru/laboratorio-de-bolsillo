import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { useIsAppActive } from './useIsAppActive';

/**
 * `true` mientras la pantalla está visible (con foco en expo-router) y la app en primer plano.
 * Con `router.push` a Historial o Calibrar el instrumento sigue montado debajo: el micrófono,
 * el altavoz y la cámara hay que soltarlos también entonces, no solo al salir de la app.
 */
export function useIsScreenActive(): boolean {
  const [isScreenFocused, setIsScreenFocused] = useState(true);
  const isAppActive = useIsAppActive();
  useFocusEffect(
    useCallback(() => {
      setIsScreenFocused(true);
      return () => setIsScreenFocused(false);
    }, []),
  );
  return isScreenFocused && isAppActive;
}

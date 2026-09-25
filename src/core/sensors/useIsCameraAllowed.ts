import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { useIsAppActive } from '@/core/useIsAppActive';

/** Cámara activa solo con la pantalla visible y la app en primer plano. */
export function useIsCameraAllowed(): boolean {
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

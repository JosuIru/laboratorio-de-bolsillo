import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/**
 * `true` mientras la app está en primer plano. Los instrumentos lo usan para cerrar el
 * micrófono o la cámara en cuanto el usuario sale de la app.
 */
export function useIsAppActive(): boolean {
  const [isAppActive, setIsAppActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const appStateSubscription = AppState.addEventListener('change', (nextAppState) =>
      setIsAppActive(nextAppState === 'active'),
    );
    return () => appStateSubscription.remove();
  }, []);
  return isAppActive;
}

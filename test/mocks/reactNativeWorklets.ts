/** Mock de react-native-worklets para Jest: ejecuta en el mismo hilo. */
export const scheduleOnRN = (callback: (...callbackArguments: unknown[]) => void, ...callbackArguments: unknown[]) =>
  callback(...callbackArguments);

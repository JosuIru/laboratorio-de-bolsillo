import { useColorScheme } from 'react-native';

const lightPalette = {
  background: '#F7F8FA',
  surface: '#FFFFFF',
  textPrimary: '#14171C',
  textSecondary: '#5B6470',
  accent: '#0B6E99',
  border: '#DDE1E6',
};

const darkPalette: typeof lightPalette = {
  background: '#0E1116',
  surface: '#171B22',
  textPrimary: '#E8EBEF',
  textSecondary: '#9AA4B0',
  accent: '#4FB3E0',
  border: '#2A303A',
};

export type ThemePalette = typeof lightPalette;

export function useThemePalette(): ThemePalette {
  return useColorScheme() === 'dark' ? darkPalette : lightPalette;
}

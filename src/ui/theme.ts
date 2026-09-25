import { useColorScheme } from 'react-native';

const lightPalette = {
  background: '#F7F8FA',
  surface: '#FFFFFF',
  textPrimary: '#14171C',
  textSecondary: '#5B6470',
  accent: '#0B6E99',
  onAccent: '#FFFFFF',
  danger: '#B3261E',
  success: '#1E7B34',
  border: '#DDE1E6',
};

const darkPalette: typeof lightPalette = {
  background: '#0E1116',
  surface: '#171B22',
  textPrimary: '#E8EBEF',
  textSecondary: '#9AA4B0',
  accent: '#4FB3E0',
  onAccent: '#06212E',
  danger: '#F2B8B5',
  success: '#7DD99A',
  border: '#2A303A',
};

export type ThemePalette = typeof lightPalette;

export function useThemePalette(): ThemePalette {
  return useColorScheme() === 'dark' ? darkPalette : lightPalette;
}

import { useColorScheme } from 'react-native';

export interface Palette {
  background: string;
  surface: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
  danger: string;
  highlight: string;
}

const light: Palette = {
  background: '#f6f6f4',
  surface: '#ffffff',
  line: '#e2e2de',
  text: '#16181d',
  muted: '#6b6f78',
  accent: '#a6192e',
  danger: '#b42318',
  highlight: '#fbe9ec',
};

const dark: Palette = {
  background: '#0f1114',
  surface: '#181b20',
  line: '#2a2e35',
  text: '#f1f2f4',
  muted: '#9aa0aa',
  accent: '#e0485d',
  danger: '#f97066',
  highlight: '#3a1d23',
};

/** Follows the phone's light or dark setting (app.config userInterfaceStyle). */
export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}

export type Theme = 'light' | 'dark' | 'system';

export function getTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  return (localStorage.getItem('theme') as Theme) || 'dark';
}

export function setTheme(theme: Theme): void {
  localStorage.setItem('theme', theme);
  applyTheme(theme);
}

export function applyTheme(theme: Theme): void {
  const resolved = theme === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    : theme;
  document.documentElement.setAttribute('data-theme', resolved);
}

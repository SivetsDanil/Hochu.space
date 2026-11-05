// Тема приложения: тёмная, светлая или как в системе, и цвет акцента.
import { emit } from './store.js';

const systemLight = matchMedia('(prefers-color-scheme: light)');
let chosen = 'dark';

/** theme: dark | light | system */
export function applyTheme(theme) {
  chosen = theme;
  const mode = theme === 'system' ? (systemLight.matches ? 'light' : 'dark') : theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = mode;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = mode === 'light' ? '#ffffff' : '#111b25';
  emit('theme', mode);
}
systemLight.addEventListener('change', () => { if (chosen === 'system') applyTheme('system'); });

export const ACCENTS = ['#5eb5f7', '#3390ec', '#4ee3a3', '#7bc862', '#f2b84b', '#ff8a5c', '#ff7aa2', '#b39dff', '#8ea4ff', '#e17076'];

/** Цвет акцента всего приложения (null — по умолчанию для темы) */
export function applyAccent(color) {
  const st = document.documentElement.style;
  if (color) {
    st.setProperty('--accent', color);
    st.setProperty('--accent-2', `color-mix(in srgb, ${color} 78%, #000)`);
    st.setProperty('--link', color);
  } else {
    ['--accent', '--accent-2', '--link'].forEach(k => st.removeProperty(k));
  }
  emit('theme', document.documentElement.dataset.theme);
}

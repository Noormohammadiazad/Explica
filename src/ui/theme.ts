/**
 * Colour theme. The system preference (prefers-color-scheme) is the default; a
 * choice made with the top-bar switch is remembered only while it differs from
 * the system, so returning to the system's theme resumes following it.
 *
 * `public/theme-boot.js` applies the same rule before first paint.
 */
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'explica.theme';

/** The theme to show: a stored explicit choice wins, otherwise the system's. */
export function resolveTheme(stored: string | null, systemDark: boolean): Theme {
  if (stored === 'light' || stored === 'dark') return stored;
  return systemDark ? 'dark' : 'light';
}

/** What to store after the user picks `theme`: nothing if it is what the system asks for anyway. */
export function themeToStore(theme: Theme, systemDark: boolean): Theme | null {
  return theme === (systemDark ? 'dark' : 'light') ? null : theme;
}

/** Browser-chrome colour (theme-color) for each theme, matching the backdrop edge. */
export const THEME_COLOR: Record<Theme, string> = { light: '#e4ddd2', dark: '#15110e' };

/** Tracks the active theme, applies it to the document, and follows the system until overridden. */
export class ThemeController {
  theme: Theme;
  onChange: (t: Theme) => void = () => {};
  private readonly mq: MediaQueryList | null;

  constructor() {
    this.mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    this.theme = resolveTheme(readStored(), this.systemDark);
    this.apply();
    this.mq?.addEventListener('change', () => {
      const next = resolveTheme(readStored(), this.systemDark);
      if (next !== this.theme) this.set(next, false);
    });
  }

  private get systemDark(): boolean {
    return !!this.mq?.matches;
  }

  toggle(): void {
    this.set(this.theme === 'dark' ? 'light' : 'dark', true);
  }

  set(t: Theme, remember: boolean): void {
    if (remember) writeStored(themeToStore(t, this.systemDark));
    if (t === this.theme) return;
    this.theme = t;
    this.apply();
    this.onChange(t);
  }

  private apply(): void {
    const root = document.documentElement;
    root.dataset.theme = this.theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[this.theme]);
  }
}

function readStored(): string | null {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

function writeStored(t: Theme | null): void {
  try {
    if (t) localStorage.setItem(THEME_KEY, t);
    else localStorage.removeItem(THEME_KEY);
  } catch {
    /* storage unavailable: the choice lasts for this visit */
  }
}

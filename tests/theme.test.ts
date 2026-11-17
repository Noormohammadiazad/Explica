import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEME_KEY, resolveTheme, themeToStore } from '../src/ui/theme';
import { KEY_LIGHT_POSITION, SCENE_PALETTES, clonePalette, mixPalette, type ScenePalette } from '../src/render/scenePalette';

describe('Theme choice', () => {
  it('follows the system until the reader chooses', () => {
    expect(resolveTheme(null, true)).toBe('dark');
    expect(resolveTheme(null, false)).toBe('light');
    expect(resolveTheme('garbage', true)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('remembers a choice only while it differs from the system', () => {
    expect(themeToStore('light', true)).toBe('light');
    expect(themeToStore('dark', true)).toBeNull();
    expect(themeToStore('dark', false)).toBe('dark');
    expect(themeToStore('light', false)).toBeNull();
  });

  it('the pre-paint boot script reads the same storage key', () => {
    const boot = readFileSync(fileURLToPath(new URL('../public/theme-boot.js', import.meta.url)), 'utf8');
    expect(boot).toContain(`'${THEME_KEY}'`);
    expect(boot).toContain('prefers-color-scheme: dark');
  });
});

/** Irradiance on an upward-facing page: key (Lambert) + hemisphere sky. */
function pageIrradiance(p: ScenePalette): number {
  const [x, y, z] = KEY_LIGHT_POSITION;
  const cos = y / Math.hypot(x, y, z);
  return p.keyIntensity * cos + p.fillIntensity;
}

describe('Scene palettes', () => {
  const { light, dark } = SCENE_PALETTES;

  it('keep paper equally white in both themes', () => {
    const a = pageIrradiance(light);
    const b = pageIrradiance(dark);
    expect(Math.abs(a - b) / b).toBeLessThan(0.08);
  });

  it('dark is a lamp (high key-to-fill contrast), light is daylight (softer self-shadows)', () => {
    expect(dark.keyIntensity / dark.fillIntensity).toBeGreaterThan(1.6 * (light.keyIntensity / light.fillIntensity));
  });

  it('the ground shadow is denser on the dark backdrop, where it is harder to see', () => {
    expect(dark.shadowOpacity).toBeGreaterThan(light.shadowOpacity);
  });

  it('blend continuously between themes, hitting both ends exactly', () => {
    const out = clonePalette(dark);
    mixPalette(dark, light, 0, out);
    expect(out.keyIntensity).toBe(dark.keyIntensity);
    expect(out.groundColor.equals(dark.groundColor)).toBe(true);
    mixPalette(dark, light, 1, out);
    expect(out.shadowOpacity).toBe(light.shadowOpacity);
    expect(out.skyColor.equals(light.skyColor)).toBe(true);
    mixPalette(dark, light, 0.5, out);
    expect(out.fillIntensity).toBeCloseTo((dark.fillIntensity + light.fillIntensity) / 2, 12);
    // the source palettes are never modified
    expect(SCENE_PALETTES.dark.keyIntensity).toBe(2.1);
  });
});

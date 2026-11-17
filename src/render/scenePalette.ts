import * as THREE from 'three';
import type { Theme } from '../ui/theme';

/** Where the key light sits (world, metres): high and to the left of the reader. */
export const KEY_LIGHT_POSITION: readonly [number, number, number] = [-0.55, 1.35, 0.5];

/**
 * Lighting of the scene for a colour theme. The backdrop itself is the page
 * behind the transparent canvas (CSS tokens); this is everything the 3D scene
 * contributes so the book sits naturally on it.
 *
 *  - Dark: a warm reading lamp in a dim room. Strong key, weak fill, so pages
 *    model with crisp self-shadows; the ground shadow is dense enough to read
 *    against a dark backdrop.
 *  - Light: daylight in a pale room. The fill (sky + bounce from a light
 *    table) carries much more of the light, so self-shadows are softer; the
 *    ground shadow is lighter, since a pale backdrop shows it readily.
 *
 * Both keep the irradiance on an upward-facing page about the same, so paper
 * stays equally white in either theme.
 */
export interface ScenePalette {
  keyColor: THREE.Color;
  keyIntensity: number;
  skyColor: THREE.Color;
  groundColor: THREE.Color;
  fillIntensity: number;
  rimIntensity: number;
  envIntensity: number;
  shadowColor: THREE.Color;
  shadowOpacity: number;
}

export const SCENE_PALETTES: Readonly<Record<Theme, Readonly<ScenePalette>>> = {
  dark: {
    keyColor: new THREE.Color(0xfff1de),
    keyIntensity: 2.1,
    skyColor: new THREE.Color(0xe4ecff),
    groundColor: new THREE.Color(0x40342a),
    fillIntensity: 0.55,
    rimIntensity: 0.45,
    envIntensity: 0.42,
    shadowColor: new THREE.Color(0x080504),
    shadowOpacity: 0.42,
  },
  light: {
    keyColor: new THREE.Color(0xfff7ee),
    keyIntensity: 1.72,
    skyColor: new THREE.Color(0xf3f6ff),
    groundColor: new THREE.Color(0xc4b8a6),
    fillIntensity: 0.92,
    rimIntensity: 0.3,
    envIntensity: 0.5,
    shadowColor: new THREE.Color(0x4a3826),
    shadowOpacity: 0.24,
  },
};

export function clonePalette(p: Readonly<ScenePalette>): ScenePalette {
  return {
    ...p,
    keyColor: p.keyColor.clone(),
    skyColor: p.skyColor.clone(),
    groundColor: p.groundColor.clone(),
    shadowColor: p.shadowColor.clone(),
  };
}

/** out = a + (b − a)·t, for every colour and scalar. */
export function mixPalette(a: Readonly<ScenePalette>, b: Readonly<ScenePalette>, t: number, out: ScenePalette): ScenePalette {
  const k = (x: number, y: number) => x + (y - x) * t;
  out.keyColor.copy(a.keyColor).lerp(b.keyColor, t);
  out.skyColor.copy(a.skyColor).lerp(b.skyColor, t);
  out.groundColor.copy(a.groundColor).lerp(b.groundColor, t);
  out.shadowColor.copy(a.shadowColor).lerp(b.shadowColor, t);
  out.keyIntensity = k(a.keyIntensity, b.keyIntensity);
  out.fillIntensity = k(a.fillIntensity, b.fillIntensity);
  out.rimIntensity = k(a.rimIntensity, b.rimIntensity);
  out.envIntensity = k(a.envIntensity, b.envIntensity);
  out.shadowOpacity = k(a.shadowOpacity, b.shadowOpacity);
  return out;
}

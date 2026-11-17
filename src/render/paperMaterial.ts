import * as THREE from 'three';

export interface PaperUniforms {
  uBackMap: { value: THREE.Texture };
  uContentRect: { value: THREE.Vector4 };
  uBackRect: { value: THREE.Vector4 };
  uShowThrough: { value: number };
  uPaperTint: { value: THREE.Color };
  uGutterAO: { value: number };
  uMirror: { value: number };
  /** 1 mirrors the print across the sheet (right-to-left books are drawn mirrored; this un-mirrors the text). */
  uFlipPrint: { value: number };
  uPageW: { value: number };
  uDetailMap: { value: THREE.Texture };
  uDetailRect: { value: THREE.Vector4 };
  uDetailOn: { value: number };
  /** The page's annotations (highlights, ink, note marks), in its content coordinates. */
  uAnnoMap: { value: THREE.Texture };
  uAnnoOn: { value: number };
}

export type PaperMaterial = THREE.MeshPhysicalMaterial & { userData: { paper: PaperUniforms } };

/**
 * Paper: rough dielectric with a soft sheen lobe (calendered paper glints at
 * grazing angles), a procedural fibre normal map, and a shader patch adding
 *  - page content letter-boxed into the sheet (`uContentRect`),
 *  - a screen-resolution detail tile for close-ups (`uDetailMap`/`uDetailRect`),
 *  - show-through of the reverse page (paper is translucent),
 *  - gutter ambient occlusion near the binding,
 *  - a warm paper tint,
 *  - an optional horizontal flip of the print (`uFlipPrint`) for mirrored books,
 *  - the reader's annotations, darken-blended over the print (`uAnnoMap`).
 */
export function createPaperMaterial(opts: {
  blank: THREE.Texture;
  fibre: THREE.Texture;
  mirror: boolean;
  pageWidth: number;
  flipPrint?: boolean;
}): PaperMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: opts.blank,
    roughness: 0.74,
    metalness: 0,
    sheen: 0.45,
    sheenRoughness: 0.42,
    sheenColor: new THREE.Color(1, 0.975, 0.94),
    specularIntensity: 0.32,
    normalMap: opts.fibre,
    normalScale: new THREE.Vector2(0.09, 0.09),
    side: THREE.FrontSide,
  }) as PaperMaterial;

  const uniforms: PaperUniforms = {
    uBackMap: { value: opts.blank },
    uContentRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uBackRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uShowThrough: { value: 0.045 },
    uPaperTint: { value: new THREE.Color(1.0, 0.975, 0.935) },
    uGutterAO: { value: 1 },
    uMirror: { value: opts.mirror ? 1 : 0 },
    uFlipPrint: { value: opts.flipPrint ? 1 : 0 },
    uPageW: { value: opts.pageWidth },
    uDetailMap: { value: opts.blank },
    uDetailRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uDetailOn: { value: 0 },
    uAnnoMap: { value: opts.blank },
    uAnnoOn: { value: 0 },
  };
  mat.userData.paper = uniforms;

  mat.customProgramCacheKey = () => 'explica-paper-v3';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <map_pars_fragment>',
        /* glsl */ `#include <map_pars_fragment>
uniform sampler2D uBackMap;
uniform sampler2D uDetailMap;
uniform vec4 uContentRect;
uniform vec4 uBackRect;
uniform vec4 uDetailRect;
uniform float uShowThrough;
uniform vec3 uPaperTint;
uniform float uGutterAO;
uniform float uMirror;
uniform float uFlipPrint;
uniform float uPageW;
uniform float uDetailOn;
uniform sampler2D uAnnoMap;
uniform float uAnnoOn;
float explicaInside(vec2 p) {
  vec2 s = step(vec2(0.0), p) * step(p, vec2(1.0));
  return s.x * s.y;
}`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#ifdef USE_MAP
  // print coordinates: the sheet's own uv, flipped across the page for mirrored books
  vec2 sheetUv = vec2(mix(vMapUv.x, 1.0 - vMapUv.x, uFlipPrint), vMapUv.y);
  vec2 cuv = (sheetUv - uContentRect.xy) / uContentRect.zw;
  // sample unconditionally: implicit derivatives must stay uniform for mip selection
  vec4 baseTexel = texture2D(map, clamp(cuv, 0.0, 1.0));
  vec2 duv = (cuv - uDetailRect.xy) / uDetailRect.zw;
  vec4 detailTexel = texture2D(uDetailMap, clamp(duv, 0.0, 1.0));
  vec4 texel = mix(baseTexel, detailTexel, uDetailOn * explicaInside(duv));
  texel = mix(vec4(1.0), texel, explicaInside(cuv));
  // annotations: darken (min) blend — highlighter tints the paper but not the type, ink shows
  vec4 anno = texture2D(uAnnoMap, clamp(cuv, 0.0, 1.0));
  texel.rgb = mix(texel.rgb, min(texel.rgb, anno.rgb), anno.a * uAnnoOn * explicaInside(cuv));
  // show-through: the reverse page seen through translucent paper (mirrored)
  vec2 buv = (vec2(1.0 - sheetUv.x, sheetUv.y) - uBackRect.xy) / uBackRect.zw;
  vec3 backTexel = texture2D(uBackMap, clamp(buv, 0.0, 1.0)).rgb;
  float backInk = (1.0 - dot(backTexel, vec3(0.2126, 0.7152, 0.0722))) * explicaInside(buv);
  texel.rgb *= 1.0 - uShowThrough * backInk;
  // gutter occlusion near the binding
  float spineDist = mix(vMapUv.x, 1.0 - vMapUv.x, uMirror) * uPageW;
  float ao = 1.0 - uGutterAO * (0.30 * exp(-spineDist / 0.011) + 0.06 * exp(-spineDist / 0.045));
  diffuseColor *= vec4(texel.rgb * uPaperTint * ao, texel.a);
#endif`,
      );
  };
  return mat;
}

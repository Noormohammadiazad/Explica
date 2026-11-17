import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { KEY_LIGHT_POSITION, SCENE_PALETTES, clonePalette, mixPalette, type ScenePalette } from './scenePalette';
import type { Theme } from '../ui/theme';

const THEME_BLEND = 0.45; // s, matches the CSS backdrop transition

/**
 * Renderer, camera, lights and the ground that catches the book's shadow.
 * Lights are fixed in the world, so turning the book in your hands moves its
 * sheen and shadows across the paper.
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** Parent of everything that belongs to the book (posed by the view controller). */
  readonly bookRoot = new THREE.Group();
  readonly key: THREE.DirectionalLight;
  private readonly fill: THREE.HemisphereLight;
  private readonly rim: THREE.DirectionalLight;
  private readonly ground: THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial>;
  private palette: ScenePalette = clonePalette(SCENE_PALETTES.dark);
  private blend: { from: ScenePalette; to: Theme; t: number } | null = null;
  private width = 1;
  private height = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
      // dev only: lets screenshot tooling read an idle canvas (render-on-demand leaves it untouched)
      preserveDrawingBuffer: import.meta.env.DEV,
    });
    const r = this.renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2.5));
    r.outputColorSpace = THREE.SRGBColorSpace;
    // Khronos PBR Neutral: keeps paper white and ink black instead of greying them
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.setClearColor(0x000000, 0);

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.02, 30);

    const pmrem = new THREE.PMREMGenerator(r);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environment = env;
    this.scene.environmentIntensity = 0.42;

    // warm key light, high and to the left, casting soft shadows
    this.key = new THREE.DirectionalLight(0xfff1de, 2.1);
    this.key.position.set(...KEY_LIGHT_POSITION);
    this.key.target.position.set(0, 0, 0);
    this.key.castShadow = true;
    const sc = this.key.shadow.camera;
    sc.left = -0.5;
    sc.right = 0.5;
    sc.top = 0.5;
    sc.bottom = -0.5;
    sc.near = 0.4;
    sc.far = 3.2;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.radius = 5;
    this.key.shadow.bias = -0.00015;
    this.key.shadow.normalBias = 0.0012;
    this.scene.add(this.key, this.key.target);

    // cool sky fill (with bounce from the table) + a faint rim from behind for the paper's sheen
    this.fill = new THREE.HemisphereLight(0xe4ecff, 0x40342a, 0.55);
    this.scene.add(this.fill);
    this.rim = new THREE.DirectionalLight(0xdfe9ff, 0.45);
    this.rim.position.set(0.6, 0.5, -1.2);
    this.scene.add(this.rim);

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.ShadowMaterial({ transparent: true }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.11;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.scene.add(this.bookRoot);
    this.applyPalette();
  }

  /** Re-lights the scene for a colour theme, blending over THEME_BLEND seconds when animated. */
  setTheme(theme: Theme, animate = true): void {
    if (!animate) {
      this.blend = null;
      this.palette = clonePalette(SCENE_PALETTES[theme]);
      this.applyPalette();
      return;
    }
    this.blend = { from: clonePalette(this.palette), to: theme, t: 0 };
  }

  /** Advances a theme blend. Returns true while the scene is still changing. */
  updateTheme(dt: number): boolean {
    const b = this.blend;
    if (!b) return false;
    b.t = Math.min(1, b.t + dt / THEME_BLEND);
    const e = b.t * b.t * (3 - 2 * b.t);
    mixPalette(b.from, SCENE_PALETTES[b.to], e, this.palette);
    this.applyPalette();
    if (b.t >= 1) this.blend = null;
    return true;
  }

  private applyPalette(): void {
    const p = this.palette;
    this.key.color.copy(p.keyColor);
    this.key.intensity = p.keyIntensity;
    this.fill.color.copy(p.skyColor);
    this.fill.groundColor.copy(p.groundColor);
    this.fill.intensity = p.fillIntensity;
    this.rim.intensity = p.rimIntensity;
    this.scene.environmentIntensity = p.envIntensity;
    this.ground.material.color.copy(p.shadowColor);
    this.ground.material.opacity = p.shadowOpacity;
  }

  /** Frees the GPU resources and the WebGL context. The stage cannot draw afterwards. */
  dispose(): void {
    this.scene.environment?.dispose();
    this.ground.geometry.dispose();
    this.ground.material.dispose();
    this.key.shadow.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /** Resizes the drawing buffer to the canvas' CSS size. Returns true if it changed. */
  resize(): boolean {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    if (w === this.width && h === this.height) return false;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    return true;
  }

  get viewportHeightPx(): number {
    return this.height * this.renderer.getPixelRatio();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}

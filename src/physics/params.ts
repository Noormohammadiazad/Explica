/** Physical parameters of a sheet of paper and its environment (SI units). */
export interface PaperParams {
  /** Areal density ρ_A [kg/m²] (80 g/m² paper → 0.08). */
  arealDensity: number;
  /** Flexural rigidity D = E t³ / 12(1−ν²) [N·m]. */
  flexuralRigidity: number;
  /** Torsional stiffness of the binding at the spine [N·m/rad]. */
  spineStiffness: number;
  /** Rest angle of the binding spring [rad] (π/2: a binding wants to close). */
  spineRestAngle: number;
  /** Stiffness-proportional (visco-elastic) damping time β [s]. */
  bendDamping: number;
  /** Viscous damping of the spine hinge [N·m·s/rad]. */
  spineDamping: number;
  /** Air density [kg/m³]. */
  airDensity: number;
  /** Flat-plate drag coefficient. */
  dragCoefficient: number;
  /** Linear air damping floor per area [N·s/m³]. */
  airLinear: number;
  /** Natural frequency of the hand spring relative to the sheet mass [rad/s]. */
  handOmega: number;
  /** Damping ratio of the hand spring. */
  handZeta: number;
  /** Natural frequency of contact penalty springs [rad/s]. */
  contactOmega: number;
  /** Damping ratio of contact springs. */
  contactZeta: number;
  /** Tangential (friction-like) contact damping ratio. */
  contactFriction: number;
}

/** 80 g/m² book paper. */
export const DEFAULT_PAPER: PaperParams = {
  arealDensity: 0.08,
  flexuralRigidity: 2.5e-4,
  spineStiffness: 4e-4,
  spineRestAngle: Math.PI / 2,
  bendDamping: 0.012,
  spineDamping: 2e-5,
  airDensity: 1.2,
  dragCoefficient: 1.2,
  airLinear: 0.02,
  handOmega: 95,
  handZeta: 0.8,
  contactOmega: 600,
  contactZeta: 1.0,
  contactFriction: 0.6,
};

/**
 * Paper of a given grammage. Thickness scales ~linearly with grammage, so
 * flexural rigidity scales with its cube (D ∝ t³), relative to the 80 g/m²
 * reference.
 */
export function paperForGrammage(gsm: number, stiffnessScale = 1): PaperParams {
  const ratio = gsm / 80;
  return {
    ...DEFAULT_PAPER,
    arealDensity: gsm / 1000,
    flexuralRigidity: DEFAULT_PAPER.flexuralRigidity * ratio ** 3 * stiffnessScale,
  };
}

/** Number of strips used by the physics model. */
export const PHYSICS_STRIPS = 24;

/** Material dimensions of a sheet. */
export interface SheetDims {
  /** Width (spine → fore-edge) [m]. */
  W: number;
  /** Height (along the spine) [m]. */
  H: number;
}

// ================================================================
//  Mermaid label contrast normalisation
// ---------------------------------------------------------------
//  Mermaid's `themeVariables` only supply *defaults* for node colours.
//  A `classDef` sets the shape `fill` but leaves the label colour on
//  the theme variable — so a light fill can carry a light text colour
//  and become unreadable. The theme layer cannot fix that, because it
//  has no idea what fill the diagram asked for.
//
//  This module measures what was actually painted and corrects the
//  label colour when — and only when — contrast is inadequate. It is
//  a floor, not a ceiling: pairings that already read are left exactly
//  as authored, so deliberate colour choices (including specific
//  colours a user asked for) survive untouched.
//
//  Single public entry point: `ensureReadableText`.
// ================================================================

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface SampledColour extends Rgb {
  /** Alpha channel in the range 0–1. */
  a: number;
}

interface TextSurface {
  /** The shape painted behind the label. */
  shape: SVGElement;
  /** Elements carrying the visible text. */
  labels: SVGElement[];
}

// ── Tuning ───────────────────────────────────────────────────

/** WCAG AA minimum contrast ratio for normal-size text. */
const MIN_CONTRAST_RATIO = 4.5;

/** The only two label colours we will apply. Pure black is needlessly harsh. */
const LIGHT_LABEL = '#ffffff';
const DARK_LABEL = '#111827';

const LIGHT_LABEL_RGB: Rgb = { r: 255, g: 255, b: 255 };
const DARK_LABEL_RGB: Rgb = { r: 17, g: 24, b: 39 };

/** Fallback backdrop when nothing opaque can be resolved. */
const DEFAULT_BACKDROP: Rgb = { r: 255, g: 255, b: 255 };

/** Elements that can act as the backdrop for a label. */
const SHAPE_SELECTOR = 'rect, polygon, path, circle, ellipse';

/** Elements that carry visible label text. */
const LABEL_SELECTOR = '.nodeLabel, .cluster-label text, text, tspan';

/** How far up the DOM to walk when resolving a translucent backdrop. */
const MAX_BACKDROP_DEPTH = 8;

// ── Colour parsing ───────────────────────────────────────────

const HEX_PATTERN = /^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;
const RGB_PATTERN =
  /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i;

function parseAlpha(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const parsed = raw.endsWith('%') ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw);
  if (Number.isNaN(parsed)) return 1;
  return Math.min(1, Math.max(0, parsed));
}

/**
 * Parse a computed CSS colour into RGBA channels.
 *
 * Returns `null` for anything we cannot measure — `none`, gradients and
 * pattern references (`url(#…)`), and fully transparent values.
 */
function parseColour(raw: string | null | undefined): SampledColour | null {
  if (!raw) return null;

  const value = raw.trim().toLowerCase();
  if (!value || value === 'none' || value === 'transparent' || value.startsWith('url(')) {
    return null;
  }

  const rgbMatch = RGB_PATTERN.exec(value);
  if (rgbMatch) {
    const a = parseAlpha(rgbMatch[4]);
    if (a === 0) return null;
    return {
      r: Number(rgbMatch[1]),
      g: Number(rgbMatch[2]),
      b: Number(rgbMatch[3]),
      a,
    };
  }

  const hexMatch = HEX_PATTERN.exec(value);
  if (hexMatch) {
    const digits = hexMatch[1]!;
    const expanded =
      digits.length <= 4 ? [...digits].map((digit) => digit + digit).join('') : digits;
    const a = expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1;
    if (a === 0) return null;
    return {
      r: Number.parseInt(expanded.slice(0, 2), 16),
      g: Number.parseInt(expanded.slice(2, 4), 16),
      b: Number.parseInt(expanded.slice(4, 6), 16),
      a,
    };
  }

  return null;
}

// ── Contrast maths (WCAG 2.1) ────────────────────────────────

function channelLuminance(channel: number): number {
  const scaled = channel / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

function contrastRatio(first: Rgb, second: Rgb): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

function composite(foreground: SampledColour, backdrop: Rgb): Rgb {
  if (foreground.a >= 1) {
    return { r: foreground.r, g: foreground.g, b: foreground.b };
  }
  return {
    r: foreground.r * foreground.a + backdrop.r * (1 - foreground.a),
    g: foreground.g * foreground.a + backdrop.g * (1 - foreground.a),
    b: foreground.b * foreground.a + backdrop.b * (1 - foreground.a),
  };
}

// ── Backdrop resolution ──────────────────────────────────────

/**
 * Resolve the opaque colour behind an element by compositing the computed
 * background colours of its ancestors.
 *
 * Locopilot's UI is glassmorphic, so several layers may be translucent.
 * Anything still unresolved at the top of the walk falls back to white.
 */
function resolveBackdrop(element: Element): Rgb {
  const layers: SampledColour[] = [];
  let current: Element | null = element;

  for (let depth = 0; current !== null && depth < MAX_BACKDROP_DEPTH; depth += 1) {
    const layer = parseColour(getComputedStyle(current).backgroundColor);
    if (layer) {
      layers.push(layer);
      if (layer.a >= 1) break;
    }
    current = current.parentElement;
  }

  let resolved: Rgb = DEFAULT_BACKDROP;
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    resolved = composite(layers[index]!, resolved);
  }
  return resolved;
}

// ── Surface discovery ────────────────────────────────────────

function textElementsIn(root: Element): SVGElement[] {
  const found = new Set<SVGElement>();

  if (root instanceof SVGElement && root.matches(LABEL_SELECTOR)) {
    found.add(root);
  }
  for (const element of root.querySelectorAll<SVGElement>(LABEL_SELECTOR)) {
    found.add(element);
  }

  return [...found];
}

function directShapeChild(parent: Element): SVGElement | null {
  for (const child of parent.children) {
    if (child.matches(SHAPE_SELECTOR)) return child as SVGElement;
  }
  return null;
}

/**
 * The shape painted behind a flowchart node's label. Mermaid tags it
 * `label-container`; the direct-child scan is a fallback for shapes that
 * carry no class.
 */
function nodeBackdrop(node: Element): SVGElement | null {
  return (
    node.querySelector<SVGElement>(':scope > .label-container') ??
    node.querySelector<SVGElement>('.label-container') ??
    directShapeChild(node)
  );
}

/** Collect every (backdrop, labels) pair in the diagram that we can measure. */
function collectTextSurfaces(svgRoot: SVGSVGElement): TextSurface[] {
  const surfaces: TextSurface[] = [];

  // Flowchart / state diagram nodes.
  for (const node of svgRoot.querySelectorAll<SVGGElement>('g.node')) {
    const shape = nodeBackdrop(node);
    const labels = textElementsIn(node);
    if (shape && labels.length > 0) surfaces.push({ shape, labels });
  }

  // Subgraph / cluster titles, painted onto the cluster rectangle.
  for (const cluster of svgRoot.querySelectorAll<SVGGElement>('g.cluster')) {
    const shape = cluster.querySelector<SVGElement>(':scope > rect') ?? directShapeChild(cluster);
    const label = cluster.querySelector<Element>('.cluster-label');
    const labels = label ? textElementsIn(label) : [];
    if (shape && labels.length > 0) surfaces.push({ shape, labels });
  }

  // Edge labels. Mermaid only paints a background rect behind these when
  // `edgeLabelBackground` is configured; without one there is nothing to
  // measure, so the label is left alone.
  for (const edgeLabel of svgRoot.querySelectorAll<SVGGElement>('g.edgeLabel')) {
    const shape = edgeLabel.querySelector<SVGElement>('rect');
    const labels = textElementsIn(edgeLabel);
    if (shape && labels.length > 0) surfaces.push({ shape, labels });
  }

  return surfaces;
}

// ── Label restyling ──────────────────────────────────────────

// Inline styles are used deliberately: they outrank the `classDef` rules
// Mermaid injects into the SVG, which a stylesheet rule would not reliably do.
function applyLabelColour(labels: SVGElement[], colour: string): void {
  for (const label of labels) {
    label.style.setProperty('fill', colour);
    // Only meaningful when htmlLabels is enabled (foreignObject text), but
    // harmless otherwise and keeps the two in step.
    label.style.setProperty('color', colour);
  }
}

/**
 * Mid-tone backdrops cannot reach WCAG AA with a solid label colour alone,
 * so give the glyphs their own contrasting outline — the text then carries
 * its own background and reads regardless of what is behind it.
 */
function applyLabelOutline(labels: SVGElement[], colour: string): void {
  for (const label of labels) {
    label.style.setProperty('paint-order', 'stroke');
    label.style.setProperty('stroke', colour);
    label.style.setProperty('stroke-width', '3px');
    label.style.setProperty('stroke-linejoin', 'round');
    label.style.setProperty('stroke-linecap', 'round');
  }
}

// ── Public API ───────────────────────────────────────────────

/**
 * Measure every label in a freshly rendered diagram and correct its colour
 * when it does not contrast with the shape behind it.
 *
 * Must be called *after* the SVG has been inserted into the document:
 * `classDef` colours arrive as CSS rules inside a `<style>` block that
 * Mermaid injects, so only the computed style reflects what was painted.
 *
 * Returns the number of labels that were corrected.
 */
export function ensureReadableText(svgRoot: SVGSVGElement): number {
  let corrected = 0;

  for (const { shape, labels } of collectTextSurfaces(svgRoot)) {
    const fill = parseColour(getComputedStyle(shape).fill);

    // `fill: none`, a gradient, or a fully transparent shape gives us nothing
    // to measure — the label sits on whatever is behind the shape instead.
    if (!fill) continue;

    const shapeOpacity = Number.parseFloat(getComputedStyle(shape).opacity || '1');
    const opacity = Number.isNaN(shapeOpacity) ? 1 : Math.min(1, Math.max(0, shapeOpacity));
    const backdrop = resolveBackdrop(shape);

    // A shape faded out by `opacity` contributes proportionally less colour.
    const effective = composite({ ...fill, a: fill.a * opacity }, backdrop);

    const lightRatio = contrastRatio(LIGHT_LABEL_RGB, effective);
    const darkRatio = contrastRatio(DARK_LABEL_RGB, effective);

    const betterColour = lightRatio >= darkRatio ? LIGHT_LABEL : DARK_LABEL;
    const betterRatio = Math.max(lightRatio, darkRatio);

    const currentFill = parseColour(getComputedStyle(labels[0]!).fill);
    const currentRatio = currentFill
      ? contrastRatio(composite(currentFill, effective), effective)
      : 0;

    // Floor, not ceiling: a pairing that already reads is left exactly as the
    // model (or the user) intended it.
    if (currentRatio >= MIN_CONTRAST_RATIO) continue;

    applyLabelColour(labels, betterColour);
    corrected += 1;

    if (betterRatio < MIN_CONTRAST_RATIO) {
      applyLabelOutline(labels, betterColour === LIGHT_LABEL ? DARK_LABEL : LIGHT_LABEL);
    }
  }

  return corrected;
}

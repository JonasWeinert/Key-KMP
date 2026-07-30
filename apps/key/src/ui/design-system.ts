import keyGlassSource from '../../../../assets/ui/key-glass.json';

export type WidthClass = 'compact' | 'regular' | 'comfortable';
export type InteractionState =
  | 'base'
  | 'hovered'
  | 'pressed'
  | 'focused'
  | 'disabled'
  | 'selected'
  | 'expanded'
  | 'dragging';

export interface AccessibilityPreferences {
  reduceMotion: boolean;
  reduceTransparency: boolean;
  increaseContrast: boolean;
}

export interface ChromeLayout {
  row_order: 'tabs_then_controls' | 'controls_then_tabs';
  tab_bar_placement: 'flow' | 'overlay';
  show_single_tab: boolean;
  show_new_tab_button: boolean;
  utility_controls_row: 'top' | 'tab' | 'control';
  utility_controls_leading_inset: number;
  tab_bar_height: number;
  tab_height: number;
  split_segment_height: number;
  tab_popover_gap: number;
  tab_leading_inset: number;
  tab_trailing_inset: number;
  control_leading_inset: number;
  tab_width: number;
  split_tab_width: number;
  new_tab_button_size: number;
  tab_min_width_ratio: number;
  title_fade_width: number;
  utility_cluster_width: number;
  trailing_reserved_width: number;
  tab_horizontal_padding: number;
  split_horizontal_padding: number;
  tab_bar_tint_opacity: number;
  active_tab_opacity: number;
  tab_bar_outline_opacity: number;
  active_tab_outline_opacity: number;
  tab_min_title_characters: number;
  tab_segment_gap: number;
  tab_close_button_size: number;
}

export interface MaterialStyle {
  opacity: number;
  border_opacity: number;
  highlight_opacity: number;
  shadow_opacity: number;
  backdrop: 'none' | 'window_blur' | 'element_blur';
}

export interface Corner {
  shape: 'square' | 'convex' | 'concave';
  radius?: number;
}

export interface CornerSpec {
  top_left: Corner;
  top_right: Corner;
  bottom_right: Corner;
  bottom_left: Corner;
}

export interface DesignSystemConfig {
  schema_version: number;
  appearance: {
    theme: { source: 'system' } | { source: 'named'; name: string };
    colors: Record<string, { red: number; green: number; blue: number; alpha?: number }>;
    icons: Record<string, string>;
  };
  policy: {
    curvature: 'enabled' | 'disabled';
    concave_corners: 'enabled' | 'disabled';
    shadows: 'enabled' | 'disabled';
    translucency: 'enabled' | 'disabled';
    motion: 'enabled' | 'disabled';
    maximum_corner_radius: number;
  };
  geometry: {
    radius_small: number;
    radius_medium: number;
    radius_large: number;
    radius_pill: number;
    control_height: number;
    compact_control_height: number;
    icon_size: number;
    panel_header_height: number;
    space_unit: number;
    border_width: number;
  };
  materials: Record<'window' | 'chrome' | 'surface' | 'floating' | 'control', MaterialStyle>;
  palette: {
    chrome_foreground_mix: number;
    canvas_foreground_mix: number;
    sidebar_foreground_mix: number;
    split_gutter_foreground_mix: number;
  };
  workspace: {
    chrome: {
      regular: ChromeLayout;
      compact: ChromeLayout | null;
      comfortable: ChromeLayout | null;
    };
    split: {
      outer_padding: number;
      pane_gap: number;
      divider_line_width: number;
    };
  };
  typography: Record<
    'caption' | 'label' | 'body' | 'heading' | 'title' | 'display',
    { size_rem: number; line_height: number; weight: string }
  >;
  interaction: {
    opacity: Record<InteractionState, number>;
    surface_opacity: Record<InteractionState, number>;
    border_opacity: Record<InteractionState, number>;
  };
  components: {
    corners: Record<string, CornerSpec>;
    common: Record<string, number>;
    popover: Record<string, number>;
    control_bar: Record<string, number>;
    references: Record<string, number>;
    extensions: Record<string, number>;
    comments: Record<string, number>;
    search: Record<string, number>;
    settings: Record<string, number>;
    editor: Record<string, number>;
  };
  reader: Record<string, number>;
  motion: Record<string, number>;
  responsive: {
    compact_max_width: number;
    comfortable_min_width: number;
  };
}

export interface ResolvedDesignSystem extends Omit<DesignSystemConfig, 'materials'> {
  materials: DesignSystemConfig['materials'];
  widthClass: WidthClass;
  chrome: ChromeLayout;
  motionAllowed: boolean;
  translucencyAllowed: boolean;
  shadowsAllowed: boolean;
}

export function utilitiesInTabRow(chrome: ChromeLayout): boolean {
  if (chrome.utility_controls_row === 'tab') return true;
  if (chrome.utility_controls_row === 'control') return false;
  return chrome.row_order === 'tabs_then_controls';
}

const REQUIRED_ROOT_KEYS = [
  'schema_version',
  'appearance',
  'policy',
  'geometry',
  'materials',
  'palette',
  'workspace',
  'typography',
  'interaction',
  'components',
  'reader',
  'motion',
  'responsive',
] as const;

function finiteNumber(value: unknown, path: string, minimum = 0, maximum = 100_000) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${path} must be a finite number between ${minimum} and ${maximum}`);
  }
}

function mergeValue(base: unknown, override: unknown): unknown {
  if (
    base &&
    override &&
    typeof base === 'object' &&
    typeof override === 'object' &&
    !Array.isArray(base) &&
    !Array.isArray(override)
  ) {
    const merged = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
      merged[key] = key in merged ? mergeValue(merged[key], value) : value;
    }
    return merged;
  }
  return override;
}

export function mergeDesignSystem(
  base: DesignSystemConfig,
  override: unknown,
): DesignSystemConfig {
  const merged = mergeValue(base, override);
  validateDesignSystem(merged);
  return merged;
}

export function validateDesignSystem(source: unknown): asserts source is DesignSystemConfig {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('design system must be an object');
  }
  const record = source as Record<string, unknown>;
  const unknown = Object.keys(record).filter(
    key => !REQUIRED_ROOT_KEYS.includes(key as (typeof REQUIRED_ROOT_KEYS)[number]),
  );
  if (unknown.length) throw new Error(`unknown design-system keys: ${unknown.join(', ')}`);
  for (const key of REQUIRED_ROOT_KEYS) {
    if (!(key in record)) throw new Error(`design system is missing ${key}`);
  }
  if (record.schema_version !== 1) {
    throw new Error(`unsupported design-system schema ${String(record.schema_version)}`);
  }
  const config = source as DesignSystemConfig;
  finiteNumber(config.policy.maximum_corner_radius, 'policy.maximum_corner_radius', 0, 2_048);
  for (const [name, value] of Object.entries(config.geometry)) {
    finiteNumber(value, `geometry.${name}`, 0, 2_048);
  }
  for (const [name, material] of Object.entries(config.materials)) {
    for (const field of ['opacity', 'border_opacity', 'highlight_opacity', 'shadow_opacity'] as const) {
      finiteNumber(material[field], `materials.${name}.${field}`, 0, 1);
    }
  }
  const layouts = [
    ['regular', config.workspace.chrome.regular],
    ['compact', config.workspace.chrome.compact],
    ['comfortable', config.workspace.chrome.comfortable],
  ] as const;
  for (const [name, layout] of layouts) {
    if (!layout) continue;
    for (const [field, value] of Object.entries(layout)) {
      if (typeof value === 'number') {
        finiteNumber(value, `workspace.chrome.${name}.${field}`, 0, 2_048);
      }
    }
    if (layout.tab_height > layout.tab_bar_height) {
      throw new Error(`workspace.chrome.${name}.tab_height exceeds tab_bar_height`);
    }
    if (layout.split_segment_height > layout.tab_height) {
      throw new Error(`workspace.chrome.${name}.split_segment_height exceeds tab_height`);
    }
  }
  if (config.responsive.compact_max_width >= config.responsive.comfortable_min_width) {
    throw new Error('responsive compact width must be below comfortable width');
  }
}

export function classifyWidth(config: DesignSystemConfig, width: number): WidthClass {
  if (width <= config.responsive.compact_max_width) return 'compact';
  if (width >= config.responsive.comfortable_min_width) return 'comfortable';
  return 'regular';
}

function resolveMaterial(
  source: MaterialStyle,
  preferences: AccessibilityPreferences,
  translucencyAllowed: boolean,
  shadowsAllowed: boolean,
): MaterialStyle {
  const opacity = translucencyAllowed ? source.opacity : 1;
  return {
    opacity: preferences.increaseContrast ? Math.min(1, opacity + 0.12) : opacity,
    border_opacity: preferences.increaseContrast
      ? Math.min(1, source.border_opacity + 0.2)
      : source.border_opacity,
    highlight_opacity: translucencyAllowed ? source.highlight_opacity : 0,
    shadow_opacity: shadowsAllowed ? source.shadow_opacity : 0,
    backdrop: translucencyAllowed ? source.backdrop : 'none',
  };
}

export function resolveDesignSystem(
  config: DesignSystemConfig,
  width: number,
  preferences: AccessibilityPreferences,
): ResolvedDesignSystem {
  const widthClass = classifyWidth(config, width);
  const motionAllowed =
    config.policy.motion !== 'disabled' && !preferences.reduceMotion;
  const translucencyAllowed =
    config.policy.translucency !== 'disabled' && !preferences.reduceTransparency;
  const shadowsAllowed = config.policy.shadows !== 'disabled';
  const selectedChrome =
    widthClass === 'compact'
      ? config.workspace.chrome.compact
      : widthClass === 'comfortable'
        ? config.workspace.chrome.comfortable
        : null;
  return {
    ...config,
    materials: Object.fromEntries(
      Object.entries(config.materials).map(([name, material]) => [
        name,
        resolveMaterial(
          material,
          preferences,
          translucencyAllowed,
          shadowsAllowed,
        ),
      ]),
    ) as DesignSystemConfig['materials'],
    widthClass,
    chrome: selectedChrome ?? config.workspace.chrome.regular,
    motionAllowed,
    translucencyAllowed,
    shadowsAllowed,
  };
}

function cornerRadius(config: ResolvedDesignSystem, role: string) {
  if (config.policy.curvature === 'disabled') return 0;
  const corner = config.components.corners[role]?.top_left;
  return Math.min(
    corner?.shape === 'square' ? 0 : corner?.radius ?? config.geometry.radius_medium,
    config.policy.maximum_corner_radius,
  );
}

export function designSystemCss(config: ResolvedDesignSystem): Record<string, string> {
  const px = (value: number) => `${value}px`;
  return {
    '--key-space': px(config.geometry.space_unit),
    '--key-radius-small': px(config.geometry.radius_small),
    '--key-radius-medium': px(config.geometry.radius_medium),
    '--key-radius-large': px(config.geometry.radius_large),
    '--key-radius-pill': px(config.geometry.radius_pill),
    '--key-radius-button': px(cornerRadius(config, 'button')),
    '--key-radius-panel': px(cornerRadius(config, 'panel')),
    '--key-radius-floating': px(cornerRadius(config, 'floating')),
    '--key-radius-tab': px(cornerRadius(config, 'tab')),
    '--key-radius-card': px(cornerRadius(config, 'card')),
    '--key-radius-context': px(cornerRadius(config, 'context_pill')),
    '--key-control-height': px(config.geometry.control_height),
    '--key-compact-control-height': px(config.geometry.compact_control_height),
    '--key-icon-size': px(config.geometry.icon_size),
    '--key-border-width': px(config.geometry.border_width),
    '--key-tabbar-height': px(config.chrome.tab_bar_height),
    '--key-tab-height': px(config.chrome.tab_height),
    '--key-tab-width': px(config.chrome.tab_width),
    '--key-split-tab-width': px(config.chrome.split_tab_width),
    '--key-tab-leading': px(config.chrome.tab_leading_inset),
    '--key-tab-trailing': px(config.chrome.tab_trailing_inset),
    '--key-tab-min-width-ratio': String(config.chrome.tab_min_width_ratio),
    '--key-tab-horizontal-padding': px(config.chrome.tab_horizontal_padding),
    '--key-split-horizontal-padding': px(config.chrome.split_horizontal_padding),
    '--key-split-segment-height': px(config.chrome.split_segment_height),
    '--key-new-tab-size': px(config.chrome.new_tab_button_size),
    '--key-title-fade-width': px(config.chrome.title_fade_width),
    '--key-tabbar-tint-opacity': String(config.chrome.tab_bar_tint_opacity),
    '--key-active-tab-opacity': String(config.chrome.active_tab_opacity),
    '--key-tabbar-outline-opacity': String(
      config.chrome.tab_bar_outline_opacity,
    ),
    '--key-active-tab-outline-opacity': String(
      config.chrome.active_tab_outline_opacity,
    ),
    '--key-tab-segment-gap': px(config.chrome.tab_segment_gap),
    '--key-tab-close-button-size': px(config.chrome.tab_close_button_size),
    '--key-icon-small': px(config.components.common.icon_small),
    '--key-split-padding': px(config.workspace.split.outer_padding),
    '--key-split-gap': px(config.workspace.split.pane_gap),
    '--key-split-divider': px(config.workspace.split.divider_line_width),
    '--key-sidebar-width': px(config.reader.sidebar_width),
    '--key-panel-margin-x': px(config.reader.panel_horizontal_margin),
    '--key-panel-margin-y': px(config.reader.panel_vertical_margin),
    '--key-context-width': px(config.reader.context_pill_width),
    '--key-context-height': px(config.reader.context_pill_height),
    '--key-motion-short': `${config.motionAllowed ? config.motion.short_duration_ms : 0}ms`,
    '--key-motion-medium': `${config.motionAllowed ? config.motion.medium_duration_ms : 0}ms`,
    '--key-material-chrome-opacity': String(config.materials.chrome.opacity),
    '--key-material-surface-opacity': String(config.materials.surface.opacity),
    '--key-material-floating-opacity': String(config.materials.floating.opacity),
    '--key-material-control-opacity': String(config.materials.control.opacity),
    '--key-material-control-border-opacity': String(
      config.materials.control.border_opacity,
    ),
    '--key-material-control-shadow-opacity': String(
      config.materials.control.shadow_opacity,
    ),
    '--key-shadow-surface-y': px(config.components.common.shadow_surface_y),
    '--key-shadow-surface-blur': px(
      config.components.common.shadow_surface_blur,
    ),
    '--key-shadow-surface-spread': px(
      config.components.common.shadow_surface_spread,
    ),
    '--key-backdrop-blur': px(config.components.common.shadow_floating_blur),
    '--key-shadow-floating-opacity': String(config.materials.floating.shadow_opacity),
  };
}

validateDesignSystem(keyGlassSource);
export const keyGlass = keyGlassSource;

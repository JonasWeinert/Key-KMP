import safariGlassSource from '../../../assets/ui/variations/safari-glass.json';
import {
  keyGlass,
  mergeDesignSystem,
  type DesignSystemConfig,
} from './ui/design-system';

export type AppVisualProfile = 'pdfjs-workspace' | 'legacy-lab';

export function visualProfileForRenderer(
  renderer: string | null,
): AppVisualProfile {
  return renderer === 'pdfjs' || renderer === 'pdfjs-workspace'
    ? 'pdfjs-workspace'
    : 'legacy-lab';
}

const PROFILE_DESIGN_SYSTEMS: Record<AppVisualProfile, DesignSystemConfig> = {
  'pdfjs-workspace': mergeDesignSystem(keyGlass, safariGlassSource),
  'legacy-lab': keyGlass,
};

export function designSystemForProfile(
  profile: AppVisualProfile,
): DesignSystemConfig {
  return PROFILE_DESIGN_SYSTEMS[profile];
}

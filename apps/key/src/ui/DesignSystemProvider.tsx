import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  designSystemCss,
  resolveDesignSystem,
  type AccessibilityPreferences,
  type DesignSystemConfig,
  type ResolvedDesignSystem,
} from './design-system';

const DesignSystemContext = createContext<ResolvedDesignSystem | null>(null);

function mediaPreference(query: string) {
  return typeof window !== 'undefined' && window.matchMedia(query).matches;
}

function preferences(): AccessibilityPreferences {
  return {
    reduceMotion: mediaPreference('(prefers-reduced-motion: reduce)'),
    reduceTransparency: mediaPreference('(prefers-reduced-transparency: reduce)'),
    increaseContrast: mediaPreference('(prefers-contrast: more)'),
  };
}

export function DesignSystemProvider({
  children,
  config,
}: {
  children: ReactNode;
  config: DesignSystemConfig;
}) {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [accessibility, setAccessibility] = useState(preferences);

  useEffect(() => {
    const queries = [
      window.matchMedia('(prefers-reduced-motion: reduce)'),
      window.matchMedia('(prefers-reduced-transparency: reduce)'),
      window.matchMedia('(prefers-contrast: more)'),
    ];
    const update = () => setAccessibility(preferences());
    const resize = () => setViewportWidth(window.innerWidth);
    queries.forEach(query => query.addEventListener('change', update));
    window.addEventListener('resize', resize, { passive: true });
    return () => {
      queries.forEach(query => query.removeEventListener('change', update));
      window.removeEventListener('resize', resize);
    };
  }, []);

  const resolved = useMemo(
    () => resolveDesignSystem(config, viewportWidth, accessibility),
    [accessibility, config, viewportWidth],
  );
  const style = useMemo(
    () => designSystemCss(resolved) as CSSProperties,
    [resolved],
  );

  return (
    <DesignSystemContext.Provider value={resolved}>
      <div
        className="key-ui-root"
        data-key-width={resolved.widthClass}
        data-key-motion={resolved.motionAllowed ? 'enabled' : 'disabled'}
        data-key-translucency={resolved.translucencyAllowed ? 'enabled' : 'disabled'}
        style={style}
      >
        {children}
      </div>
    </DesignSystemContext.Provider>
  );
}

export function useDesignSystem() {
  const context = useContext(DesignSystemContext);
  if (!context) throw new Error('useDesignSystem requires DesignSystemProvider');
  return context;
}

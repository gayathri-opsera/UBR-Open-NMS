/**
 * V2 useBreakpoint hook (WO-009 supplement)
 * Returns current breakpoint info based on window width.
 */
import { useEffect, useState } from 'react';

export type Breakpoint = 'mobile' | 'tablet' | 'desktop' | 'desktop-lg' | 'desktop-xl' | 'desktop-2xl';

interface BreakpointInfo {
  bp: Breakpoint;
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  width: number;
}

function getBreakpoint(width: number): Breakpoint {
  if (width < 768) return 'mobile';
  if (width < 1280) return 'tablet';
  if (width < 1440) return 'desktop';
  if (width < 1920) return 'desktop-lg';
  if (width < 2560) return 'desktop-xl';
  return 'desktop-2xl';
}

export function useBreakpoint(): BreakpointInfo {
  const [width, setWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1440));

  useEffect(() => {
    const handler = () => setWidth(window.innerWidth);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  const bp = getBreakpoint(width);
  return {
    bp,
    isMobile: bp === 'mobile',
    isTablet: bp === 'tablet',
    isDesktop: !['mobile', 'tablet'].includes(bp),
    width,
  };
}

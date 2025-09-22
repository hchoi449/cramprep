import React, { useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import confetti from 'canvas-confetti';

export type UseCelebrateOptions = {
  active: boolean;
  durationMs?: number; // default 800ms
  intensity?: number;  // 0-1, default 0.6
  anchor?: HTMLElement | null;
};

export function useCelebrate({ active, durationMs = 800, intensity = 0.6, anchor }: UseCelebrateOptions) {
  const firedRef = useRef(false);
  const prefersReduced = useMemo(() =>
    typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  []);

  useEffect(() => {
    if (!active || firedRef.current) return;
    firedRef.current = true;
    let timeout: number | undefined;

    try {
      if (!prefersReduced && anchor) {
        const rect = anchor.getBoundingClientRect();
        const x = (rect.left + rect.width - 8) / window.innerWidth; // right side of label
        const y = (rect.top + rect.height / 2) / window.innerHeight;
        confetti({
          particleCount: Math.round(80 * intensity),
          spread: 50,
          startVelocity: 25,
          gravity: 0.9,
          origin: { x, y },
          scalar: 0.9,
          ticks: 180,
          zIndex: 10000,
        });
      }
    } catch {}

    timeout = window.setTimeout(() => { firedRef.current = false; }, durationMs + 100);
    return () => { if (timeout) window.clearTimeout(timeout); };
  }, [active, durationMs, intensity, anchor, prefersReduced]);
}

export type CelebratePulseProps = {
  trigger: boolean;
  anchorRef: React.RefObject<HTMLElement>;
  durationMs?: number;
  className?: string;
};

export const CelebratePulse: React.FC<CelebratePulseProps> = ({ trigger, anchorRef, durationMs = 800, className }) => {
  const prefersReduced = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  return (
    <AnimatePresence>
      {trigger && anchorRef.current && (
        <motion.span
          aria-hidden
          className={['pointer-events-none absolute -right-1 top-1/2 -translate-y-1/2 h-6 w-6 rounded-full', className || ''].join(' ')}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{
            opacity: 1,
            scale: prefersReduced ? 1 : [0.6, 1.15, 0.9, 1.05, 1],
            boxShadow: prefersReduced ? '0 0 0 0 rgba(16,185,129,0.0)' : ['0 0 0 0 rgba(16,185,129,0.5)', '0 0 0 10px rgba(16,185,129,0)', '0 0 0 0 rgba(16,185,129,0)'],
            backgroundColor: prefersReduced ? '#10b981' : '#10b981',
          }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{ duration: prefersReduced ? 0.4 : durationMs / 1000, ease: 'easeOut' }}
          style={{ zIndex: 10 }}
        />
      )}
    </AnimatePresence>
  );
};

export const CelebratePortal: React.FC<{ trigger: boolean; anchorRef: React.RefObject<HTMLElement>; durationMs?: number; intensity?: number; }>
  = ({ trigger, anchorRef, durationMs = 800, intensity = 0.6 }) => {
  useCelebrate({ active: trigger, durationMs, intensity, anchor: anchorRef.current! });
  return <CelebratePulse trigger={trigger} anchorRef={anchorRef as React.RefObject<HTMLElement>} durationMs={durationMs} />;
};

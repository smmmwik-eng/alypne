import { cn } from '@/lib/format';

/** Alypne mark: a peak (the "A") with a card-shaped crossbar — progress up the board. */
export function LogoMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="var(--accent)" />
      <path d="M9 23.5 15.1 8.9a1 1 0 0 1 1.8 0L23 23.5" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="11.6" y="17" width="8.8" height="3.4" rx="1.7" fill="#fff" fillOpacity=".55" />
    </svg>
  );
}

export function Logo({ size = 24, className, wordmark = true }: { size?: number; className?: string; wordmark?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2 select-none', className)}>
      <LogoMark size={size} />
      {wordmark && (
        <span className="font-semibold tracking-[-0.03em] text-fg" style={{ fontSize: size * 0.72 }}>
          alypne
        </span>
      )}
    </span>
  );
}

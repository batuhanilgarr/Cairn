/** The Cairn mark: nested diamonds. Follows the accent colour. */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="logo-svg">
      <path d="M12 2 L22 12 L12 22 L2 12 Z" fill="var(--accent)" />
      <path d="M12 7 L17 12 L12 17 L7 12 Z" fill="var(--bg-side)" />
      <path d="M12 9.6 L14.4 12 L12 14.4 L9.6 12 Z" fill="var(--accent)" />
    </svg>
  );
}

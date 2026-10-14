/** The Cairn mark: four balanced stones, the top one in the accent colour. */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logo-svg">
      <ellipse cx="16" cy="25.5" rx="12" ry="5" fill="#74848b" />
      <ellipse cx="16.8" cy="17.2" rx="8.6" ry="4.2" fill="#aab4b4" transform="rotate(-3 16.8 17.2)" />
      <ellipse cx="15.6" cy="10.6" rx="5.6" ry="3.4" fill="#74848b" transform="rotate(4 15.6 10.6)" />
      <ellipse cx="16.2" cy="5.8" rx="3" ry="2.4" fill="var(--accent)" />
    </svg>
  );
}

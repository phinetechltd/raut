import Image from "next/image";

/**
 * The Raut mark.
 *
 * This renders the supplied brand artwork from `/brand/raut-icon.png` — an
 * earlier version redrew the mark in SVG, which drifted from the real logo.
 * The artwork is the source of truth; do not substitute a recreation.
 *
 * The PNG carries transparency outside the rounded square, so it sits cleanly
 * on any background without a plate behind it.
 */
export function RautMark({
  className,
  size = 64,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <Image
      src="/brand/raut-icon.png"
      alt="Raut"
      width={size}
      height={size}
      className={className}
      priority
    />
  );
}

/** Mark plus wordmark, for headers with room for it. */
export function RautWordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <RautMark
        size={compact ? 24 : 36}
        className={compact ? "h-6 w-6" : "h-9 w-9"}
      />
      <span className="leading-none">
        <span
          className={`block font-semibold tracking-tight ${
            compact ? "text-sm" : "text-lg"
          }`}
        >
          Raut
        </span>
        {!compact ? (
          <span className="muted mt-0.5 block text-[9px] uppercase tracking-[0.12em]">
            One Platform. Every Mile.
          </span>
        ) : null}
      </span>
    </span>
  );
}

/**
 * The full lockup — mark, wordmark and strapline — for the login hero and
 * anywhere the brand is presented rather than merely referenced.
 *
 * `onDark` sets it on a white patch instead of recolouring it. The supplied
 * artwork is navy on light; dropped straight onto the navy hero its wordmark
 * disappears, and repainting a logo to suit a background is exactly the kind
 * of "improvement" that turns brand artwork into a lookalike.
 */
export function RautLockup({
  size = 260,
  onDark = false,
}: {
  size?: number;
  onDark?: boolean;
}) {
  const img = (
    <Image
      src="/brand/raut-logo-tagline.png"
      alt="Raut — one platform, every mile"
      width={size}
      height={Math.round(size * 0.605)}
      priority
    />
  );

  if (!onDark) return img;
  return (
    <span className="inline-flex rounded-2xl bg-white px-6 py-5 shadow-sm">
      {img}
    </span>
  );
}

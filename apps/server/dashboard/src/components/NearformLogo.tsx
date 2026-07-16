interface Props {
  /** Rendered size in px (width == height). Defaults to 28. */
  size?: number;
  className?: string;
}

/**
 * The Nearform "N" monogram with its bright-green underline bar.
 *
 * The letterform is `currentColor` so it inherits a theme-driven colour — pair
 * with the `.nf-logo` class (see src/index.css), which resolves it to brand
 * navy (#000e38) on the light `neaform` theme and white on the dark `lastlight`
 * theme. The green bar (#00e6a4) is fixed and reads on both.
 */
export function NearformLogo({ size = 28, className }: Props) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role="img"
      aria-label="Nearform"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path fill="#00e6a4" d="M38.06,47.42h20.42v5.35h-20.42v-5.35Z" />
      <path
        fill="currentColor"
        d="M5.52,11.05h5.46l17.72,25.77V11.05h5.87v36.37h-5.46L11.39,21.65v25.77h-5.87V11.05Z"
      />
    </svg>
  );
}

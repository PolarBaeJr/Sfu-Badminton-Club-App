// A minimal shuttlecock glyph used as the app logo mark — cork base plus
// three fanned feather ribs. Inherits color via currentColor (white on the
// red brand square).
export function ShuttleMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ position: 'relative', zIndex: 1 }}
    >
      <circle cx="12" cy="17.6" r="2.2" fill="currentColor" stroke="none" />
      <path d="M10.2 15.9 6 5.4" />
      <path d="M12 15.9V4.2" />
      <path d="M13.8 15.9 18 5.4" />
      <path d="M7.4 9.1c3-1.5 6.2-1.5 9.2 0" />
    </svg>
  );
}

// --bg-elevated, not --bg-secondary: the admin theme has never defined a
// `secondary` background (globals.css declares primary/surface/card/elevated),
// so every block below was painted with an invalid custom property and rendered
// transparent. An animate-pulse on nothing is nothing — this whole skeleton was
// an empty screen, and neither the build nor the console said so.
export default function FeesLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-10 w-48 bg-[var(--bg-elevated)] rounded" />
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 bg-[var(--bg-elevated)] rounded-lg" />
        ))}
      </div>
    </div>
  );
}

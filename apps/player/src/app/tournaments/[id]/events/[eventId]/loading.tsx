export default function EventLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Header skeleton */}
      <div className="h-8 w-48 bg-[var(--bg-secondary)] rounded" />
      <div className="h-4 w-32 bg-[var(--bg-secondary)] rounded" />

      {/* Status banner skeleton */}
      <div className="h-16 bg-[var(--bg-secondary)] rounded-lg" />

      {/* Bracket / matches skeleton */}
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 bg-[var(--bg-secondary)] rounded-lg" />
        ))}
      </div>
    </div>
  );
}

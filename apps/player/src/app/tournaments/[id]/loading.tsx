export default function TournamentLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Hero skeleton */}
      <div className="h-40 bg-[var(--bg-secondary)] rounded-xl" />

      {/* Info cards skeleton */}
      <div className="grid grid-cols-2 gap-3">
        <div className="h-20 bg-[var(--bg-secondary)] rounded-lg" />
        <div className="h-20 bg-[var(--bg-secondary)] rounded-lg" />
      </div>

      {/* Events list skeleton */}
      <div className="space-y-3">
        <div className="h-6 w-32 bg-[var(--bg-secondary)] rounded" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-24 bg-[var(--bg-secondary)] rounded-lg" />
        ))}
      </div>
    </div>
  );
}

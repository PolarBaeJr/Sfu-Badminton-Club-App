export default function TournamentsLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-10 w-48 bg-[var(--bg-secondary)] rounded" />
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 bg-[var(--bg-secondary)]" />
        ))}
      </div>
    </div>
  );
}

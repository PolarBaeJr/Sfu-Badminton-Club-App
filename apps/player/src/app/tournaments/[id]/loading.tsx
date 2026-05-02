export default function TournamentLoading() {
  return (
    <div className="space-y-5 px-4 sm:px-0">
      {/* Back link skeleton */}
      <div className="skeleton h-4 w-32 rounded-full" />

      {/* Hero card skeleton */}
      <div className="card-elevated overflow-hidden">
        <div className="h-1.5 skeleton" />
        <div className="p-5 space-y-3">
          <div className="skeleton h-3 w-20 rounded-full" />
          <div className="skeleton h-8 w-56" />
          <div className="skeleton h-4 w-40 rounded-full" />
          <div className="flex gap-2">
            <div className="skeleton h-5 w-16 rounded-full" />
            <div className="skeleton h-5 w-24 rounded-full" />
          </div>
        </div>
      </div>

      {/* Events heading */}
      <div className="skeleton h-5 w-20" />

      {/* Event cards skeleton */}
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="card-surface p-5 space-y-3">
            <div className="skeleton h-5 w-32" />
            <div className="flex gap-2">
              <div className="skeleton h-4 w-16 rounded-full" />
              <div className="skeleton h-4 w-12 rounded-full" />
            </div>
            <div className="flex items-center justify-between">
              <div className="skeleton h-3 w-20 rounded-full" />
              <div className="skeleton h-7 w-20" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

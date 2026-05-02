export default function EventLoading() {
  return (
    <div className="space-y-5 px-4 sm:px-0">
      {/* Back link skeleton */}
      <div className="skeleton h-4 w-40" />

      {/* Header card skeleton */}
      <div className="card-elevated overflow-hidden">
        <div className="h-1.5 skeleton" />
        <div className="p-5 space-y-3">
          <div className="skeleton h-3 w-16" />
          <div className="skeleton h-8 w-48" />
          <div className="skeleton h-4 w-56" />
          <div className="flex gap-2">
            <div className="skeleton h-5 w-20" />
            <div className="skeleton h-5 w-24" />
            <div className="skeleton h-5 w-16" />
          </div>
          <div className="skeleton h-9 w-28" />
        </div>
      </div>

      {/* Bracket / match results skeleton */}
      <div className="card-elevated p-5 space-y-3">
        <div className="skeleton h-5 w-24" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skeleton h-16" />
        ))}
      </div>

      {/* Participants skeleton */}
      <div className="card-elevated p-5 space-y-2">
        <div className="skeleton h-5 w-28 mb-3" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="skeleton h-10" />
        ))}
      </div>
    </div>
  );
}

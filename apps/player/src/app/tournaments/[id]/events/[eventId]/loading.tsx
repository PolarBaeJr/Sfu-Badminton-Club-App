export default function EventLoading() {
  return (
    <div className="space-y-5 px-4 sm:px-0">
      {/* Back link skeleton */}
      <div className="skeleton h-4 w-40 rounded-lg" />

      {/* Header card skeleton */}
      <div className="card-elevated rounded-2xl overflow-hidden">
        <div className="h-1.5 skeleton" />
        <div className="p-5 space-y-3">
          <div className="skeleton h-3 w-16 rounded-lg" />
          <div className="skeleton h-8 w-48 rounded-lg" />
          <div className="skeleton h-4 w-56 rounded-lg" />
          <div className="flex gap-2">
            <div className="skeleton h-5 w-20 rounded-lg" />
            <div className="skeleton h-5 w-24 rounded-lg" />
            <div className="skeleton h-5 w-16 rounded-lg" />
          </div>
          <div className="skeleton h-9 w-28 rounded-xl" />
        </div>
      </div>

      {/* Bracket / match results skeleton */}
      <div className="card-elevated rounded-2xl p-5 space-y-3">
        <div className="skeleton h-5 w-24 rounded-lg" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skeleton h-16 rounded-xl" />
        ))}
      </div>

      {/* Participants skeleton */}
      <div className="card-elevated rounded-2xl p-5 space-y-2">
        <div className="skeleton h-5 w-28 rounded-lg mb-3" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="skeleton h-10 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

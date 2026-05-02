export default function EventLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Header skeleton */}
      <div className="flex items-center justify-between">
        <div>
          <div className="h-8 w-64 bg-[var(--bg-surface)] rounded" />
          <div className="h-4 w-40 bg-[var(--bg-surface)] rounded mt-2" />
        </div>
        <div className="flex gap-2">
          <div className="h-10 w-28 bg-[var(--bg-surface)] rounded" />
          <div className="h-10 w-28 bg-[var(--bg-surface)] rounded" />
        </div>
      </div>

      {/* Tabs skeleton */}
      <div className="flex gap-2 border-b border-[var(--border)] pb-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-9 w-24 bg-[var(--bg-surface)] rounded" />
        ))}
      </div>

      {/* Content skeleton */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-32 bg-[var(--bg-surface)]" />
        ))}
      </div>
    </div>
  );
}

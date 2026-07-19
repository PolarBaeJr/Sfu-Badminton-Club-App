export default function Loading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-8 w-64 rounded bg-[var(--on-surface-med)]" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[0, 1, 2].map(i => (
          <div key={i} className="h-32 rounded-xl bg-[var(--on-surface-med)]" />
        ))}
      </div>
      <div className="space-y-2">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="h-16 rounded-lg bg-[var(--on-surface-med)]" />
        ))}
      </div>
    </div>
  );
}

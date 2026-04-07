export default function Loading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-10 w-48 rounded bg-white/5" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="h-24 rounded-xl bg-white/5" />
        ))}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[0, 1, 2, 3, 4, 5, 6, 7].map(i => (
          <div key={i} className="h-20 rounded-xl bg-white/5" />
        ))}
      </div>
      <div className="h-64 rounded-xl bg-white/5" />
    </div>
  );
}

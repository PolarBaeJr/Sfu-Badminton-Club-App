export default function Loading() {
  return (
    <div className="space-y-8 animate-pulse">
      <div>
        <div className="h-8 w-48 rounded bg-white/5" />
        <div className="mt-2 h-4 w-72 rounded bg-white/5" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="h-28 rounded-xl bg-white/5" />
        ))}
      </div>
      <div className="h-80 rounded-xl bg-white/5" />
    </div>
  );
}

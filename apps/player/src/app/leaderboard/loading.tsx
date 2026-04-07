export default function Loading() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="h-10 w-56 rounded bg-white/5" />
      <div className="space-y-2">
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => (
          <div key={i} className="h-14 rounded-lg bg-white/5" />
        ))}
      </div>
    </div>
  );
}

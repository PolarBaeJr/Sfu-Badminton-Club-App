export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="skeleton h-10 w-48 rounded" />
      <div className="card-surface p-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="skeleton h-24" />
          ))}
        </div>
      </div>
      <div className="card-surface p-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[0, 1, 2, 3, 4, 5, 6, 7].map(i => (
            <div key={i} className="skeleton h-20" />
          ))}
        </div>
      </div>
      <div className="card-surface p-3">
        <div className="skeleton h-64" />
      </div>
    </div>
  );
}

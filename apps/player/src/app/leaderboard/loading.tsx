export default function Loading() {
  return (
    <div className="space-y-4">
      <div className="skeleton h-10 w-56 rounded" />
      <div className="card-surface overflow-hidden">
        <div className="space-y-2 p-2">
          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => (
            <div key={i} className="skeleton h-14 rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}

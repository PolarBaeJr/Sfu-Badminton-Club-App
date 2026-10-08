export default function Loading() {
  return (
    <div className="space-y-4">
      <div className="skeleton h-10 w-56 rounded" />
      {/* The format rail and the search row, so the controls do not jump into
          place under a thumb that is already reaching for them. */}
      <div className="skeleton h-8 w-full rounded" />
      <div className="skeleton h-11 w-full rounded" />
      <div className="card-surface overflow-hidden">
        <div className="space-y-2 p-2">
          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => (
            <div key={i} className="skeleton h-16 rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}

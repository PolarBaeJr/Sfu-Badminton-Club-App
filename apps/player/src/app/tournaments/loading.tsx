export default function TournamentsLoading() {
  return (
    <div className="space-y-6">
      <div className="skeleton h-10 w-48" />
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skeleton h-24" />
        ))}
      </div>
    </div>
  );
}

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="skeleton h-10 w-48 rounded" />
      <div className="card-surface p-3">
        <div className="skeleton h-24 rounded-xl" />
      </div>
      <div className="card-surface p-3">
        <div className="skeleton h-40 rounded-xl" />
      </div>
    </div>
  );
}

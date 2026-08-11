// Mirrors the redesigned screen's shape: a short back link, the display title,
// the outstanding card, then the receipt list. A skeleton that does not match
// the layout it precedes makes the page appear to jump when it arrives.
export default function Loading() {
  return (
    <div className="fees">
      <div className="fees-head">
        <div className="skeleton h-3 w-20 rounded" />
        <div className="skeleton mt-3 h-10 w-32 rounded" />
        <div className="skeleton mt-3 h-4 w-56 rounded" />
      </div>
      <div className="fees-grid wide-grid">
        <div className="fees-col">
          <div className="card-base fees-outstanding">
            <div className="skeleton h-3 w-24 rounded" />
            <div className="skeleton mt-4 h-12 w-40 rounded" />
            <div className="skeleton mt-5 h-3 w-full rounded" />
          </div>
          <div className="fees-section">
            <div className="skeleton h-3 w-16 rounded" />
            <div className="skeleton mt-4 h-14 w-full rounded" />
            <div className="skeleton mt-3 h-14 w-full rounded" />
          </div>
        </div>
        <div className="fees-col">
          <div className="card-base fees-prices">
            <div className="skeleton h-3 w-32 rounded" />
            <div className="skeleton mt-4 h-12 w-full rounded" />
            <div className="skeleton mt-3 h-12 w-full rounded" />
          </div>
        </div>
      </div>
    </div>
  );
}

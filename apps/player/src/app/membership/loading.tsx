// The same shape as the page: the title, the prices card, the socials card.
export default function Loading() {
  return (
    <div className="fees">
      <div className="fees-head">
        <div className="skeleton mt-3 h-10 w-40 rounded" />
        <div className="skeleton mt-3 h-4 w-56 rounded" />
      </div>
      <div className="fees-grid wide-grid">
        <div className="fees-col">
          <div className="card-base fees-prices">
            <div className="skeleton h-3 w-32 rounded" />
            <div className="skeleton mt-4 h-12 w-full rounded" />
            <div className="skeleton mt-3 h-12 w-full rounded" />
          </div>
        </div>
        <div className="fees-col">
          <div className="card-base fees-prices">
            <div className="skeleton h-3 w-24 rounded" />
            <div className="skeleton mt-4 h-12 w-full rounded" />
          </div>
        </div>
      </div>
    </div>
  );
}

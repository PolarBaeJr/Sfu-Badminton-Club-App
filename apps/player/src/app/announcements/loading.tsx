export default function Loading() {
  return (
    <div className="m-only" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="skeleton" style={{ height: 32, width: '60%' }} />
      <div className="skeleton" style={{ height: 18, width: '40%' }} />
      <div className="skeleton" style={{ height: 120, width: '100%', marginTop: 8 }} />
      <div className="skeleton" style={{ height: 80, width: '100%' }} />
      <div className="skeleton" style={{ height: 80, width: '100%' }} />
    </div>
  );
}

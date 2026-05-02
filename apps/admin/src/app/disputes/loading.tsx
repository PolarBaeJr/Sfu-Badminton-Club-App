export default function Loading() {
  return (
    <div style={{ padding: '36px 48px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="skeleton" style={{ height: 18, width: 120 }} />
      <div className="skeleton" style={{ height: 44, width: '40%' }} />
      <div className="skeleton" style={{ height: 12, width: '60%', marginTop: 6 }} />
      <div className="skeleton" style={{ height: 200, width: '100%', marginTop: 12 }} />
    </div>
  );
}

export default function NotFound() {
  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        padding: '2rem',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        backgroundColor: '#0d0d0d',
        color: '#e0e0e0',
        textAlign: 'center',
      }}
    >
      <h1 style={{ fontSize: '1.5rem', fontWeight: 600, margin: '0 0 0.5rem' }}>
        404 — Page not found
      </h1>
      <p style={{ fontSize: '0.9rem', color: '#888', margin: 0 }}>
        The page you requested does not exist.
      </p>
    </main>
  );
}

'use client';

interface Props {
  command: { name: string; args: any };
  onApprove: () => void;
  onReject: () => void;
}

export default function ApprovalModal({ command, onApprove, onReject }: Props) {
  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.6)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
    }}>
      <div style={{
        background: 'var(--bg-secondary)',
        borderRadius: '12px',
        padding: '24px',
        maxWidth: '500px',
        width: '90%',
        border: '1px solid #444',
      }}>
        <h3 style={{ margin: '0 0 16px 0', fontSize: '16px' }}>
          Allow this command to run?
        </h3>
        <div style={{
          background: 'var(--bg-tertiary)',
          borderRadius: '8px',
          padding: '12px',
          marginBottom: '16px',
          fontFamily: 'monospace',
          fontSize: '13px',
          whiteSpace: 'pre-wrap',
          maxHeight: '200px',
          overflow: 'auto',
        }}>
          {typeof command.args === 'string' ? command.args : JSON.stringify(command.args, null, 2)}
        </div>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            onClick={onReject}
            style={{
              padding: '8px 20px',
              borderRadius: '8px',
              border: '1px solid #555',
              background: 'transparent',
              color: 'var(--text-primary)',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            Reject
          </button>
          <button
            onClick={onApprove}
            style={{
              padding: '8px 20px',
              borderRadius: '8px',
              border: 'none',
              background: 'var(--accent)',
              color: 'white',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: 'bold',
            }}
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}

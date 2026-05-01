'use client';

import '@/app/styles.css';

interface Props {
  command: { name: string; args: any };
  onApprove: () => void;
  onReject: () => void;
}

export default function ApprovalModal({ command, onApprove, onReject }: Props) {
  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <h3 className="modal-title">
          Allow this command to run?
        </h3>
        <div className="modal-command-box">
          <div className="modal-command-text">
            {typeof command.args === 'string' ? command.args : JSON.stringify(command.args, null, 2)}
          </div>
        </div>
        <div className="modal-actions">
          <button
            className="modal-btn-reject"
            onClick={onReject}
          >
            Reject
          </button>
          <button
            className="modal-btn-approve"
            onClick={onApprove}
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}

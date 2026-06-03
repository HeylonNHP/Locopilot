'use client';
import './ApprovalModal.scss';

interface Props {
  command: { name: string; args: any; toolCallName?: string };
  onApprove: () => void;
  onReject: () => void;
}

function formatArgs(args: any, commandName?: string, toolCallName?: string): React.ReactNode {
  if (commandName === 'mcp_call') {
    // Render the namespaced MCP tool as a friendly header, then a
    // key/value list of the arguments (not raw JSON).
    return (
      <>
        {toolCallName ? (
          <div className="modal-mcp-tool-name">
            Allow MCP tool <strong>{toolCallName}</strong>?
          </div>
        ) : null}
        <div className="modal-args-list">
          {args && typeof args === 'object' ? (
            Object.entries(args).map(([key, value]) => (
              <div key={key} className="modal-args-row">
                <span className="modal-args-key">{key}:</span>
                <span className="modal-args-value">
                  {typeof value === 'string' ? value : JSON.stringify(value)}
                </span>
              </div>
            ))
          ) : (
            <div className="modal-args-row">
              <span className="modal-args-value">{(args ?? '').toString()}</span>
            </div>
          )}
        </div>
      </>
    );
  }
  // Default (run_command and any other tool): show raw args.
  return typeof args === 'string' ? args : JSON.stringify(args, null, 2);
}

export default function ApprovalModal({ command, onApprove, onReject }: Props) {
  const isMcpCall = command.name === 'mcp_call';
  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <h3 className="modal-title">
          {isMcpCall && command.toolCallName
            ? `Allow MCP tool ${command.toolCallName}?`
            : 'Allow this command to run?'}
        </h3>
        <div className="modal-command-box">
          {isMcpCall ? (
            formatArgs(command.args, command.name, command.toolCallName)
          ) : (
            <div className="modal-command-text">
              {typeof command.args === 'string' ? command.args : JSON.stringify(command.args, null, 2)}
            </div>
          )}
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

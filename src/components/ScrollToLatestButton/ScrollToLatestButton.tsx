'use client';
import './ScrollToLatestButton.scss';

interface ScrollToLatestButtonProps {
  visible: boolean;
  onClick: () => void;
}

export default function ScrollToLatestButton({ visible, onClick }: ScrollToLatestButtonProps) {
  if (!visible) {
    return null;
  }

  return (
    <button
      type="button"
      className="scroll-to-latest-btn"
      onClick={onClick}
      aria-label="Scroll to the latest message"
    >
      <span aria-hidden="true">↓</span>
      <span>Latest</span>
    </button>
  );
}
import { useEffect } from 'react';

interface UseClickOutsideEscapeOptions {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Closes a popup/panel when the user clicks outside of it or presses Escape.
 *
 * @param ref - Ref attached to the panel/popover element.
 * @param options - `isOpen` controls whether listeners are active; `onClose`
 *   is called when an outside click or Escape key is detected.
 */
export function useClickOutsideEscape(
  ref: React.RefObject<HTMLElement | null>,
  { isOpen, onClose }: UseClickOutsideEscapeOptions
): void {
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);

    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [isOpen, onClose, ref]);
}

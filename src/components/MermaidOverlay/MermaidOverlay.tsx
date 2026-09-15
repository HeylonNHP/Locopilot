'use client';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { TransformComponent, TransformWrapper } from 'react-zoom-pan-pinch';

import { useClickOutsideEscape } from '@/app/hooks/useClickOutsideEscape';

import './MermaidOverlay.scss';

interface Props {
  svgMarkup: string;
  onClose: () => void;
  returnFocusRef: React.RefObject<HTMLElement | null>;
}

// Renders the already-rendered Mermaid SVG (cloned via outerHTML from the
// inline diagram — see MermaidBlock) inside a fullscreen pan/zoom overlay.
// Cloning instead of re-rendering means click-directive handlers bound by
// mermaid's bindFunctions do not carry over; acceptable since this overlay
// is for viewing/panning, not diagram interaction.
export default function MermaidOverlay({ svgMarkup, onClose, returnFocusRef }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Escape-to-close only. Click-outside is handled explicitly below via
  // handleBackdropClick, guarded to the exact backdrop target — the hook's
  // own click-outside arm would fire on nothing (ref is the full-viewport
  // root, so nothing is ever "outside" it) and is effectively inert here.
  useClickOutsideEscape(overlayRef, { isOpen: true, onClose });

  useEffect(() => {
    closeBtnRef.current?.focus();
    return () => {
      returnFocusRef.current?.focus();
    };
  }, [returnFocusRef]);

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Only a direct click on the backdrop closes the overlay — a pan-drag
    // gesture that starts on the backdrop and bubbles here must not.
    if (e.target === e.currentTarget) onClose();
  };

  return createPortal(
    <div
      ref={overlayRef}
      className="mermaid-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded diagram"
      onClick={handleBackdropClick}
    >
      <div className="mermaid-overlay-panel">
        <TransformWrapper
          initialScale={1}
          minScale={0.25}
          maxScale={8}
          limitToBounds={false}
          centerOnInit
          // `smooth` (default true) scales the zoom step by the wheel
          // event's raw deltaY, which is tuned for trackpads that emit many
          // small deltas. A physical mouse wheel reports one large deltaY
          // per notch (~100+), which under `smooth` blew the zoom straight
          // to minScale/maxScale on a single click. Disabling it makes each
          // wheel notch apply a fixed `step` instead, regardless of the
          // input device's deltaY magnitude.
          smooth={false}
          wheel={{ step: 0.1 }}
          doubleClick={{ mode: 'reset' }}
        >
          {({ zoomIn, zoomOut, resetTransform }) => (
            <>
              <div className="mermaid-overlay-toolbar">
                <button
                  type="button"
                  className="mermaid-overlay-btn"
                  aria-label="Zoom in"
                  onClick={() => zoomIn()}
                >
                  +
                </button>
                <button
                  type="button"
                  className="mermaid-overlay-btn"
                  aria-label="Zoom out"
                  onClick={() => zoomOut()}
                >
                  −
                </button>
                <button
                  type="button"
                  className="mermaid-overlay-btn"
                  aria-label="Reset zoom"
                  onClick={() => resetTransform()}
                >
                  Reset
                </button>
                <button
                  ref={closeBtnRef}
                  type="button"
                  className="mermaid-overlay-btn mermaid-overlay-close"
                  aria-label="Close expanded diagram"
                  onClick={onClose}
                >
                  ×
                </button>
              </div>
              <TransformComponent
                wrapperClass="mermaid-overlay-canvas-wrap"
                wrapperStyle={{ width: '100%', height: '100%' }}
                contentStyle={{ width: '100%', height: '100%' }}
              >
                <div
                  className="mermaid-overlay-canvas"
                  dangerouslySetInnerHTML={{ __html: svgMarkup }}
                />
              </TransformComponent>
            </>
          )}
        </TransformWrapper>
      </div>
    </div>,
    document.body
  );
}

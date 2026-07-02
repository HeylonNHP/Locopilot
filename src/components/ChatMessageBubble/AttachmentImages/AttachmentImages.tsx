'use client';
import Image from 'next/image';
import React from 'react';

import { detectImageMimeType } from './detectImageMimeType';

import './AttachmentImages.scss';

interface Props {
  images: string[];
}

/** Renders the images array attached to a message as a flex thumbnail strip. */
export function AttachmentImages({ images }: Props) {
  if (images.length === 0) return null;
  return (
    <div className="bubble-attachment-images">
      {images.map((base64, i) => {
        const mime = detectImageMimeType(base64);
        // Stable key: use a short content prefix so React doesn't mix up siblings
        const key = `img-${i}-${base64.slice(0, 16)}`;
        return (
          <Image
            key={key}
            src={`data:${mime};base64,${base64}`}
            alt={`Attached image ${i + 1}`}
            className="bubble-attachment-image"
            width={320}
            height={240}
            unoptimized
          />
        );
      })}
    </div>
  );
}

// ============================================================================
// ChartTypeIcons.tsx — crisp monochrome line-art glyphs for every chart type.
//
// stroke/fill = currentColor so each glyph inherits the active/inactive colour
// of the tile it sits in. Shared by the dedicated Bar-style menu
// (ChartTypeMenu) and the compact per-pane selector (TimeframeMegaSelector).
// ============================================================================

import React from 'react';
import type { ChartType } from '@/components/chart/core/types';

export function ChartTypeGlyph({ type, size = 18 }: { type: ChartType; size?: number }) {
  const s = {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none' as const,
    stroke: 'currentColor', strokeWidth: 1.6,
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  };
  switch (type) {
    case 'bars':
      return (
        <svg {...s}>
          <line x1="8" y1="4" x2="8" y2="20" />
          <line x1="4.5" y1="8" x2="8" y2="8" />
          <line x1="8" y1="15" x2="11.5" y2="15" />
          <line x1="16" y1="5" x2="16" y2="19" />
          <line x1="12.5" y1="10" x2="16" y2="10" />
          <line x1="16" y1="13" x2="19.5" y2="13" />
        </svg>
      );
    case 'candlestick':
    case 'heikinAshi':
      return (
        <svg {...s}>
          <line x1="8" y1="3" x2="8" y2="21" />
          <rect x="5.5" y="7" width="5" height="9" rx="1" fill="currentColor" stroke="none" />
          <line x1="16" y1="4" x2="16" y2="20" />
          <rect x="13.5" y="9" width="5" height="7" rx="1" fill="none" />
        </svg>
      );
    case 'hollowCandle':
      return (
        <svg {...s}>
          <line x1="8" y1="3" x2="8" y2="21" />
          <rect x="5.5" y="7" width="5" height="9" rx="1" fill="none" />
          <line x1="16" y1="4" x2="16" y2="20" />
          <rect x="13.5" y="9" width="5" height="7" rx="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'volumeCandle':
      return (
        <svg {...s}>
          <line x1="7" y1="4" x2="7" y2="20" />
          <rect x="4.5" y="8" width="5" height="8" rx="1" fill="currentColor" stroke="none" />
          <line x1="16" y1="5" x2="16" y2="19" />
          <rect x="12.5" y="9" width="7" height="6" rx="1" fill="currentColor" stroke="none" opacity="0.55" />
        </svg>
      );
    case 'line':
      return (
        <svg {...s}>
          <polyline points="3,16 8,10 12,13 16,6 21,9" />
        </svg>
      );
    case 'lineMarkers':
      return (
        <svg {...s}>
          <polyline points="3,16 8,10 12,13 16,6 21,9" />
          <circle cx="3" cy="16" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="8" cy="10" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="12" cy="13" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="16" cy="6" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="21" cy="9" r="1.6" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'stepLine':
      return (
        <svg {...s}>
          <polyline points="3,17 8,17 8,11 13,11 13,14 18,14 18,7 21,7" />
        </svg>
      );
    case 'area':
      return (
        <svg {...s}>
          <polyline points="3,16 8,10 12,13 16,6 21,9" />
          <path d="M3 16 L8 10 L12 13 L16 6 L21 9 L21 20 L3 20 Z" fill="currentColor" stroke="none" opacity="0.22" />
        </svg>
      );
    case 'hlcArea':
      return (
        <svg {...s}>
          <path d="M3 8 L8 6 L12 9 L16 5 L21 7 L21 15 L16 17 L12 14 L8 16 L3 14 Z" fill="currentColor" stroke="none" opacity="0.22" />
          <polyline points="3,11 8,10 12,12 16,9 21,11" />
        </svg>
      );
    case 'baseline':
      return (
        <svg {...s}>
          <line x1="3" y1="12" x2="21" y2="12" strokeDasharray="2 2" opacity="0.7" />
          <polyline points="3,15 7,9 11,12 15,7 21,13" />
        </svg>
      );
    case 'renko':
      return (
        <svg {...s}>
          <rect x="4" y="13" width="5" height="5" rx="0.5" fill="currentColor" stroke="none" />
          <rect x="9.5" y="9" width="5" height="5" rx="0.5" fill="currentColor" stroke="none" />
          <rect x="15" y="5" width="5" height="5" rx="0.5" fill="none" />
        </svg>
      );
    case 'lineBreak':
      return (
        <svg {...s}>
          <rect x="4" y="12" width="4" height="6" rx="0.5" fill="currentColor" stroke="none" />
          <rect x="9" y="7" width="4" height="7" rx="0.5" fill="none" />
          <rect x="14" y="10" width="4" height="8" rx="0.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'kagi':
      return (
        <svg {...s}>
          <path d="M4 18 L4 12 L9 12 L9 6 L14 6 L14 14 L19 14 L19 8" />
        </svg>
      );
    case 'pointFigure':
      return (
        <svg {...s} strokeWidth={1.3}>
          <line x1="5" y1="7" x2="8" y2="10" /><line x1="8" y1="7" x2="5" y2="10" />
          <line x1="5" y1="12" x2="8" y2="15" /><line x1="8" y1="12" x2="5" y2="15" />
          <circle cx="13" cy="9" r="1.7" /><circle cx="13" cy="13.5" r="1.7" />
          <line x1="17" y1="6" x2="20" y2="9" /><line x1="20" y1="6" x2="17" y2="9" />
        </svg>
      );
    default:
      return <svg {...s} />;
  }
}

export default ChartTypeGlyph;

// Shared, mutable selection for the emoji / sticker drawing tool.
// The DrawingToolsPanel writes `current` when the user picks an emoji; the
// ChartDrawingOverlay reads it when placing a new sticker. A tiny module
// singleton avoids threading an extra prop through mount.tsx / Backtesting.tsx.
export const emojiSelection = { current: '📈' };

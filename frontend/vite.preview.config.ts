import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Dev-only config for the Item-8 HUD preview harness (frontend/preview). Serves
// a normal page (not the library bundle) so the real OnChartHUD component can be
// reviewed live. Never used by the production build.
export default defineConfig({
  root: path.resolve(__dirname, 'preview'),
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: {
    host: '0.0.0.0',
    port: 5199,
    allowedHosts: true,
  },
});

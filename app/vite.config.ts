import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The engine is consumed straight from TypeScript source so dev needs no build step.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@cybergrid/engine': fileURLToPath(
        new URL('../packages/engine/src/index.ts', import.meta.url)
      ),
    },
  },
  server: { port: 5173 },
  build: { target: 'es2022' },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the bundle works BOTH at the custom-subdomain root
// (hive.silkvelvetrecords.com) AND at the github.io/<repo>/ preview path.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false },
});

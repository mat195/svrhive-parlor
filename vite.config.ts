import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Custom subdomain root (hive.silkvelvetrecords.com) → base '/'.
export default defineConfig({
  base: '/',
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false },
});

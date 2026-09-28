import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        popup: 'src/popup.jsx',
        background: 'src/background.js',
        content: 'src/content.js',
        wallet: 'src/wallet.js'
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/chunk-[hash].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
});

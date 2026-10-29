import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('three/build/three.core.js')) return 'three-core';
          if (id.includes('three/build/three.module.js')) return 'three-renderer';
          if (id.includes('three/examples/')) return 'three-effects';
          if (id.includes('/gsap/') || id.includes('/lenis/')) return 'motion';
        },
      },
    },
  },
});

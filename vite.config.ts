import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [{
    name: 'clean-urls',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/how' || req.url?.startsWith('/how?')) req.url = req.url.replace('/how', '/how.html');
        next();
      });
    },
  }],
  build: {
    rollupOptions: {
      input: { main: 'index.html', how: 'how.html' },
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

import { defineConfig } from 'nitro';

export default defineConfig({
  modules: ['workflow/nitro'],
  sourcemap: true,
  routes: {
    '/**': './src/index.ts',
  },
  plugins: ['plugins/start-pg-world.ts'],
});

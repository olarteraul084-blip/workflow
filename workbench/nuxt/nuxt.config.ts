import { fileURLToPath } from 'node:url';

export default defineNuxtConfig({
  compatibilityDate: 'latest',
  modules: ['workflow/nuxt'],
  nitro: { sourcemap: true },
  alias: {
    '@repo': fileURLToPath(new URL('../../', import.meta.url)),
  },
});

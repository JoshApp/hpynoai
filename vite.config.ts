import { defineConfig } from 'vite';

export default defineConfig({
  base: '/hpynoai/',
  plugins: [
    {
      name: 'shader-loader',
      transform(code, id) {
        if (id.endsWith('.vert') || id.endsWith('.frag')) {
          return {
            code: `export default ${JSON.stringify(code)};`,
            map: null,
          };
        }
      },
    },
  ],
});

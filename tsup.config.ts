import { defineConfig } from 'tsup';
import fs from 'fs';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  clean: true,
  dts: true,
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  onSuccess: async () => {
    if (fs.existsSync('templates')) {
      fs.cpSync('templates', 'dist/templates', { recursive: true });
    }
  },
});

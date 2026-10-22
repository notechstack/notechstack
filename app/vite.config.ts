import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'app',
          environment: 'jsdom',
          setupFiles: './src/test/setup.ts',
          css: true,
          include: ['src/**/*.test.{ts,tsx}'],
        },
      },
      {
        // Nó Fiscal: funções da Vercel em api/ e scripts locais. Os testes de api/
        // rodam contra o banco local do Supabase (ver api/_tests/fixtures.ts).
        test: {
          name: 'api',
          environment: 'node',
          include: ['api/**/*.test.ts', 'scripts/**/*.test.ts'],
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
    ],
  },
})

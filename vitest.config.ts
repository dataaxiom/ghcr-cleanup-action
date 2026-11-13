import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/ci-tester.ts'],
      all: true,
      clean: true,
      // A few points under current coverage (95 / 89 / 98 / 95 on
      // 2026-11-13) so a real drop fails CI without flaking on small edits.
      thresholds: {
        statements: 92,
        branches: 85,
        functions: 95,
        lines: 92
      }
    },
    mockReset: true,
    clearMocks: true,
    restoreMocks: true
  },
  resolve: {
    extensions: ['.ts', '.js'],
    alias: {
      // Handle .js imports to .ts files
      '@/': new URL('./src/', import.meta.url).pathname
    }
  },
  oxc: {
    target: 'node24'
  }
})

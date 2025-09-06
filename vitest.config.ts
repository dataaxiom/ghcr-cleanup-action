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
      thresholds: {
        statements: 0,
        branches: 0,
        functions: 0,
        lines: 0
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
  esbuild: {
    target: 'node20'
  }
})

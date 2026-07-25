import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.test.ts']
        }
      },
      {
        plugins: [react()],
        resolve: {
          alias: {
            '@shared': resolve('src/shared')
          }
        },
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['src/ui/**/*.test.tsx', 'src/web/**/*.test.tsx'],
          setupFiles: ['src/ui/test/setup.ts'],
          server: {
            deps: {
              inline: ['@primer/react', '@primer/primitives']
            }
          }
        }
      }
    ]
  }
})

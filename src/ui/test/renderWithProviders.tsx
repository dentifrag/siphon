import type { ReactElement } from 'react'
import { render, type RenderOptions } from '@testing-library/react'
import { BaseStyles, ThemeProvider } from '@primer/react'

export function renderWithProviders(ui: ReactElement, options?: RenderOptions) {
  return render(
    <ThemeProvider colorMode="auto">
      <BaseStyles>{ui}</BaseStyles>
    </ThemeProvider>,
    options
  )
}

export * from '@testing-library/react'

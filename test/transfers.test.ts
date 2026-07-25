import { describe, expect, it } from 'vitest'
import { applyDownloadEvent } from '../src/ui/lib/transfers'
import type { TransferProgress } from '../src/shared/types'

function makeTransfer(overrides: Partial<TransferProgress> = {}): TransferProgress {
  return {
    id: 't1',
    remotePath: '/remote/a',
    localPath: '/local/a',
    size: 100,
    transferred: 0,
    speedBytesPerSec: 0,
    activeSegments: 0,
    segments: 1,
    status: 'queued',
    ...overrides
  }
}

describe('applyDownloadEvent', () => {
  it('replaces the list on reset', () => {
    const prev = [makeTransfer({ id: 'old' })]
    const transfers = [makeTransfer({ id: 'a' }), makeTransfer({ id: 'b' })]
    const next = applyDownloadEvent(prev, { type: 'reset', transfers })
    expect(next).toBe(transfers)
  })

  it('filters by id on remove', () => {
    const prev = [makeTransfer({ id: 'a' }), makeTransfer({ id: 'b' })]
    const next = applyDownloadEvent(prev, { type: 'remove', id: 'a' })
    expect(next.map((t) => t.id)).toEqual(['b'])
  })

  it('replaces an existing transfer by id on update', () => {
    const prev = [makeTransfer({ id: 'a', transferred: 0 }), makeTransfer({ id: 'b' })]
    const updated = makeTransfer({ id: 'a', transferred: 50 })
    const next = applyDownloadEvent(prev, { type: 'update', transfer: updated })
    expect(next).toEqual([updated, makeTransfer({ id: 'b' })])
  })

  it('appends when the updated id is missing', () => {
    const prev = [makeTransfer({ id: 'a' })]
    const updated = makeTransfer({ id: 'c' })
    const next = applyDownloadEvent(prev, { type: 'update', transfer: updated })
    expect(next.map((t) => t.id)).toEqual(['a', 'c'])
  })
})

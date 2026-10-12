import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DownloadAdmission,
  DownloadCommitInput,
  DownloadConflict,
  DownloadPlan,
  DownloadPlanInput
} from '@shared/api'

export interface CollisionChoice {
  conflict: DownloadConflict
  batch: boolean
  index: number
  count: number
  choose: (decision: 'overwrite' | 'skip' | 'cancel') => void
}

export function useDownloadCollisions() {
  const [choice, setChoice] = useState<CollisionChoice | null>(null)
  const pendingRef = useRef<((decision: 'overwrite' | 'skip' | 'cancel') => void) | null>(null)
  const mountedRef = useRef(true)
  const busyRef = useRef(false)
  const aliveRef = useRef<(() => boolean) | null>(null)

  const cancelChoice = useCallback(() => {
    pendingRef.current?.('cancel')
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      pendingRef.current?.('cancel')
    }
  }, [])
  useEffect(() => {
    if (pendingRef.current && aliveRef.current && !aliveRef.current()) cancelChoice()
  })

  const execute = useCallback(
    async (
      prepare: () => Promise<DownloadPlan>,
      alive: () => boolean
    ): Promise<DownloadAdmission | null> => {
      if (busyRef.current) throw new Error('Finish the pending download choice first.')
      busyRef.current = true
      aliveRef.current = alive
      let plan: DownloadPlan | undefined
      let expiry: ReturnType<typeof setTimeout> | undefined
      try {
        plan = await prepare()
        expiry = setTimeout(cancelChoice, Math.max(0, plan.expiresAt - Date.now()))
        const decisions: DownloadCommitInput['decisions'] = {}
        for (const [index, conflict] of plan.conflicts.entries()) {
          if (!mountedRef.current || !alive()) return null
          const decision = await new Promise<'overwrite' | 'skip' | 'cancel'>((resolve) => {
            const choose = (next: 'overwrite' | 'skip' | 'cancel') => {
              if (pendingRef.current !== choose) return
              pendingRef.current = null
              if (mountedRef.current) setChoice(null)
              resolve(next)
            }
            pendingRef.current = choose
            setChoice({
              conflict,
              batch: plan!.batch,
              index,
              count: plan!.conflicts.length,
              choose
            })
          })
          if (decision === 'cancel') return null
          decisions[conflict.entryId] = decision
        }
        if (!mountedRef.current || !alive()) return null
        return await window.api.commitDownload({ planId: plan.id, decisions })
      } finally {
        busyRef.current = false
        aliveRef.current = null
        if (expiry) clearTimeout(expiry)
        if (plan) await window.api.releaseDownloadPlan(plan.id)
      }
    },
    [cancelChoice]
  )

  const download = useCallback(
    (input: DownloadPlanInput, alive: () => boolean) =>
      execute(() => window.api.planDownload(input), alive),
    [execute]
  )
  const retry = useCallback(
    async (id: string, alive: () => boolean) => {
      const admission = await execute(() => window.api.planDownloadRetry(id), alive)
      return admission?.transfers[0] ?? null
    },
    [execute]
  )

  return { choice, cancelChoice, download, retry }
}

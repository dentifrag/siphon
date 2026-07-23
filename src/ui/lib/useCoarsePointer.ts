import { useEffect, useState } from 'react'

function getIsCoarsePointer(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(pointer: coarse)').matches
}

export function useCoarsePointer(): boolean {
  const [isCoarse, setIsCoarse] = useState<boolean>(getIsCoarsePointer)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia('(pointer: coarse)')
    const onChange = (): void => setIsCoarse(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return isCoarse
}

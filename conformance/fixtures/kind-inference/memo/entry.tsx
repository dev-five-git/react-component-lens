import { memo } from 'react'

export const Memoized = memo(function Memoized() {
  return <div />
})

export function Host() {
  return <Memoized />
}

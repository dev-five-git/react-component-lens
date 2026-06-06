import * as React from 'react'

export const Memoized = React.memo(function Memoized() {
  return <div />
})

export function Host() {
  return <Memoized />
}

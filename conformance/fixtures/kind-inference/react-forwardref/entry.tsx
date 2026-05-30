import * as React from 'react'

export const Fancy = React.forwardRef(function Fancy() {
  return <div />
})

export function Host() {
  return <Fancy />
}

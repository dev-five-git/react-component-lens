import { forwardRef } from 'react'

export const Fancy = forwardRef(function Fancy() {
  return <div />
})

export function Host() {
  return <Fancy />
}

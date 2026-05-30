import type { Thing } from './Thing'

export function Consumer(props: { thing: Thing }) {
  return <Consumer {...props} />
}

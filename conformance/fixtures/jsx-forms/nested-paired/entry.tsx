export function Box() {
  return (
    <Inner>
      <Leaf />
    </Inner>
  )
}

function Inner(props: { children: unknown }) {
  return props.children
}

function Leaf() {
  return null
}

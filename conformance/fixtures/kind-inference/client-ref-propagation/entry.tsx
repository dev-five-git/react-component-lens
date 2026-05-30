export function Screen() {
  const handleSelect = () => undefined

  return <Selectable onSelect={handleSelect} />
}

function Selectable(props: { onSelect: () => void }) {
  return props.onSelect
}

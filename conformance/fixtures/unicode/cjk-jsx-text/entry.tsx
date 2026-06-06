export function Greeting() {
  return <Label>안녕하세요 😀 世界</Label>
}

function Label(props: { children: unknown }) {
  return props.children
}

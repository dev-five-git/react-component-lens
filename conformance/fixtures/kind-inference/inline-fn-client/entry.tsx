export function Widget() {
  return <Pressable onPress={() => undefined} />
}

function Pressable(props: { onPress: () => void }) {
  return props.onPress
}

function Alpha() {
  return null
}

function Beta() {
  return null
}

export { Alpha, Beta }

export function Wrapper() {
  return (
    <Alpha>
      <Beta />
    </Alpha>
  )
}

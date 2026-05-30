export async function AsyncList() {
  const data = await Promise.resolve<string[]>([])
  return <ul>{data}</ul>
}

export function Caller() {
  return <AsyncList />
}

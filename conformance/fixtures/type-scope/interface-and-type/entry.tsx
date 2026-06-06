export interface PanelProps {
  title: string
}

export type PanelVariant = 'primary' | 'secondary'

export function Panel(props: PanelProps & { variant: PanelVariant }) {
  return <Panel {...props} />
}

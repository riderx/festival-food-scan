declare module 'lucide-react/dist/esm/icons/*.mjs' {
  import type { ForwardRefExoticComponent, RefAttributes, SVGProps } from 'react'

  type LucideIcon = ForwardRefExoticComponent<
    Omit<
      SVGProps<SVGSVGElement> & {
        absoluteStrokeWidth?: boolean
        size?: number | string
      },
      'ref'
    > &
      RefAttributes<SVGSVGElement>
  >

  const icon: LucideIcon
  export default icon
}

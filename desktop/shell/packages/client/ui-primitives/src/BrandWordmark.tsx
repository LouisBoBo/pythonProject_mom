import type { IconProps } from './icons/props.ts'
import { FishLogo } from './FishLogo.tsx'

/** Display options for the product name. */
export interface BrandWordmarkProps extends IconProps {
  /** Whether to include the leading mark; defaults to true. */
  includeMark?: boolean | undefined
}

/**
 * Render the product name.
 * @param props.size - height in px used to size the mark and the type.
 * @param props.className - extra class for layout placement.
 * @param props.includeMark - whether to include the leading mark.
 * @returns the name, with the mark when requested.
 */
export function BrandWordmark({ size = 24, className, includeMark = true }: BrandWordmarkProps) {
  const name = (
    <span style={{ fontSize: Math.max(13, Math.round(size * 0.72)), fontWeight: 600, lineHeight: 1 }}>
      江西中软工作助手
    </span>
  )
  if (!includeMark) return <span className={className}>{name}</span>
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <FishLogo size={size} />
      {name}
    </span>
  )
}

import { useState } from 'react'

/**
 * A round image (coin or source logo) on a light plate, falling back to the first letter when
 * there is no image or it fails to load.
 */
export function Avatar({
  src,
  label,
  size = 'md',
  className = '',
}: {
  src: string | null | undefined
  label: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const [broken, setBroken] = useState(false)
  const sizes = { sm: 'size-5 text-[9px]', md: 'size-8 text-xs', lg: 'size-10 text-sm' }
  const showImage = src && !broken
  return (
    <span
      className={`inline-grid shrink-0 place-items-center overflow-hidden rounded-full font-medium uppercase ${
        showImage ? 'bg-logo' : 'bg-muted text-muted-foreground'
      } ${sizes[size]} ${className}`}
      aria-hidden
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          className="size-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        label.slice(0, 1)
      )}
    </span>
  )
}

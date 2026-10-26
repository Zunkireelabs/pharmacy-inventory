import { t } from '@lingui/core/macro';
import { ActionIcon, useComputedColorScheme } from '@mantine/core';
import { type ReactNode, forwardRef, useState } from 'react';
import { NavLink } from 'react-router-dom';

import logo128 from '../../assets/nexa-logo-128.png';
import logo256 from '../../assets/nexa-logo-256.png';

export const InvenTreeLogoHomeButton = forwardRef<HTMLDivElement>(
  (props, ref) => {
    return (
      <div ref={ref} {...props}>
        <NavLink to={'/'}>
          <ActionIcon size={32} variant='transparent'>
            <InvenTreeLogo />
          </ActionIcon>
        </NavLink>
      </div>
    );
  }
);

/*
 * Render the product logo (the Zunkireelabs mark).
 * The artwork is black line-art on a transparent background, so it is
 * inverted to white in dark mode. If the image cannot load, fall back to
 * the small "NX" mark instead of leaving a blank space.
 */
export function InvenTreeLogo({
  size = 32,
  large = false
}: Readonly<{ size?: number; large?: boolean }>): ReactNode {
  const colorScheme = useComputedColorScheme('light');
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: size,
          width: size,
          borderRadius: 6,
          background: '#1c7ed6',
          color: 'white',
          fontWeight: 700,
          fontSize: Math.round(size * 0.43),
          letterSpacing: '-0.5px'
        }}
        aria-label={t`Nexa Logo`}
      >
        NX
      </div>
    );
  }

  return (
    <img
      src={large ? logo256 : logo128}
      alt={t`Nexa Logo`}
      width={size}
      height={size}
      style={{
        display: 'block',
        objectFit: 'contain',
        filter: colorScheme === 'dark' ? 'invert(1)' : undefined
      }}
      onError={() => setFailed(true)}
    />
  );
}

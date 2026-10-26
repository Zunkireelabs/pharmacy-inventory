import { t } from '@lingui/core/macro';
import { ActionIcon } from '@mantine/core';
import { type ReactNode, forwardRef } from 'react';
import { NavLink } from 'react-router-dom';

import { useShallow } from 'zustand/react/shallow';
import { useServerApiState } from '../../states/ServerApiState';

export const InvenTreeLogoHomeButton = forwardRef<HTMLDivElement>(
  (props, ref) => {
    return (
      <div ref={ref} {...props}>
        <NavLink to={'/'}>
          <ActionIcon size={28} variant='transparent'>
            <InvenTreeLogo />
          </ActionIcon>
        </NavLink>
      </div>
    );
  }
);

/*
 * Render the Nexa logo
 * - Uses the custom logo if one is defined on the server
 * - Otherwise, uses the default Nexa wordmark
 */
export function InvenTreeLogo(): ReactNode {
  const [server] = useServerApiState(
    useShallow((state) => [state.server, state.fetchServerApiState])
  );

  if (server.server && server.customize?.logo) {
    return <img src={server.customize.logo} alt={t`Nexa Logo`} height={28} />;
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 28,
        width: 28,
        borderRadius: 6,
        background: '#1c7ed6',
        color: 'white',
        fontWeight: 700,
        fontSize: 12,
        letterSpacing: '-0.5px'
      }}
      aria-label={t`Nexa Logo`}
    >
      NX
    </div>
  );
}

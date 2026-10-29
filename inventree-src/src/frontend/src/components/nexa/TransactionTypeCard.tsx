import { Card, Stack, Text, UnstyledButton } from '@mantine/core';
import type { ReactNode } from 'react';

/**
 * One large tap-target in the New Sale type selector. Deliberately big and
 * few (4 max) — this replaces a dropdown/menu as the primary interaction
 * for the single most-used screen in the app.
 */
export function TransactionTypeCard({
  label,
  icon,
  color,
  active,
  onClick
}: Readonly<{
  label: string;
  icon: ReactNode;
  color: string;
  active: boolean;
  onClick: () => void;
}>) {
  return (
    <UnstyledButton
      onClick={onClick}
      style={{ flex: 1, minWidth: 120, height: '100%' }}
    >
      {/* Same height for every card, so one- and two-line labels line up */}
      <Card
        withBorder
        padding='md'
        radius='md'
        h='100%'
        bg={active ? `${color}.0` : undefined}
        style={{
          borderColor: active
            ? `var(--mantine-color-${color}-6)`
            : 'var(--mantine-color-default-border)',
          // always 2px, so selecting a card does not shift the others
          borderWidth: 2,
          textAlign: 'center'
        }}
      >
        <Stack align='center' justify='center' gap='xs' h='100%' mih={96}>
          {icon}
          <Text fw={700} size='sm' c={active ? color : undefined}>
            {label}
          </Text>
        </Stack>
      </Card>
    </UnstyledButton>
  );
}

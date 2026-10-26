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
    <UnstyledButton onClick={onClick} style={{ flex: 1, minWidth: 120 }}>
      <Card
        withBorder
        padding='lg'
        radius='md'
        bg={active ? `${color}.0` : undefined}
        style={{
          borderColor: active ? `var(--mantine-color-${color}-6)` : undefined,
          borderWidth: active ? 2 : 1,
          textAlign: 'center'
        }}
      >
        <Stack align='center' gap='xs'>
          {icon}
          <Text fw={700} size='sm' c={active ? color : undefined}>
            {label}
          </Text>
        </Stack>
      </Card>
    </UnstyledButton>
  );
}

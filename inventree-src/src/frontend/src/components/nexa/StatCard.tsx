import { Card, Group, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';

export function StatCard({
  label,
  value,
  icon,
  color
}: Readonly<{
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  color?: string;
}>) {
  return (
    <Card withBorder padding='md' radius='md'>
      <Group justify='space-between' wrap='nowrap' align='flex-start'>
        <Stack gap={4}>
          <Text size='xs' c='dimmed' tt='uppercase' fw={700}>
            {label}
          </Text>
          <Text size='xl' fw={700} c={color}>
            {value}
          </Text>
        </Stack>
        {icon}
      </Group>
    </Card>
  );
}

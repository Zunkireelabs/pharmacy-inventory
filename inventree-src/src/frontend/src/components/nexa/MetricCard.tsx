import { Card, Group, Skeleton, Stack, Text, ThemeIcon } from '@mantine/core';
import type { ReactNode } from 'react';

/**
 * Dashboard headline metric tile — deliberately heavier visual weight than
 * the reporting pages' StatCard (bigger number, an icon chip, optional
 * color emphasis) since these are the numbers a shop owner's eye should
 * land on first when opening the app.
 */
export function MetricCard({
  label,
  value,
  icon,
  color = 'blue',
  loading = false,
  hint
}: Readonly<{
  label: string;
  value: ReactNode;
  icon: ReactNode;
  color?: string;
  loading?: boolean;
  hint?: string;
}>) {
  return (
    <Card withBorder padding='lg' radius='md'>
      <Group justify='space-between' align='flex-start' wrap='nowrap'>
        <Stack gap={2}>
          <Text size='xs' c='dimmed' tt='uppercase' fw={700}>
            {label}
          </Text>
          {loading ? (
            <Skeleton height={28} width={90} mt={4} />
          ) : (
            <Text size='xl' fw={800} c={color}>
              {value}
            </Text>
          )}
          {hint && !loading && (
            <Text size='xs' c='dimmed'>
              {hint}
            </Text>
          )}
        </Stack>
        <ThemeIcon variant='light' color={color} size='lg' radius='md'>
          {icon}
        </ThemeIcon>
      </Group>
    </Card>
  );
}

import { t } from '@lingui/core/macro';
import { Alert, Card, Stack, Switch, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../../App';
import { useUserState } from '../../states/UserState';

type Flags = { requires_prescription: boolean; is_controlled: boolean };

/**
 * Pharmacy flags for one medicine: prescription-only and controlled.
 * Prescription-only medicines cannot be sold over the counter (the New Sale
 * form and the API both enforce it); controlled medicines additionally need
 * the prescription reference. A controlled medicine is always prescription-only.
 */
export default function MedicineFlagsPanel({
  partId
}: Readonly<{ partId: number }>) {
  const queryClient = useQueryClient();
  const isStaff = useUserState((state) => state.isStaff)();
  const url = `/plugin/nexainventory/medicine/${partId}/`;

  const query = useQuery({
    queryKey: ['nexa-medicine', partId],
    queryFn: async () => (await api.get<Flags>(url)).data
  });

  const mutation = useMutation({
    mutationFn: async (patch: Partial<Flags>) =>
      (await api.put<Flags>(url, patch)).data,
    onSuccess: (data) => {
      queryClient.setQueryData(['nexa-medicine', partId], data);
      queryClient.invalidateQueries({ queryKey: ['nexa-medicine-flags'] });
      notifications.show({ message: t`Saved`, color: 'green' });
    },
    onError: () =>
      notifications.show({ message: t`Could not save`, color: 'red' })
  });

  if (query.isError) {
    return (
      <Alert color='red' icon={<IconAlertCircle size={16} />}>
        {t`Could not load the pharmacy settings for this medicine`}
      </Alert>
    );
  }

  const flags = query.data;

  return (
    <Card withBorder maw={560}>
      <Stack>
        <Text fw={700}>{t`Prescription control`}</Text>
        {!isStaff && (
          <Text size='sm' c='dimmed'>
            {t`Only an owner or admin can change these settings.`}
          </Text>
        )}
        <Switch
          label={t`Prescription only (Rx)`}
          description={t`Cannot be sold over the counter; sell it as a Prescription.`}
          checked={!!flags?.requires_prescription}
          disabled={
            !isStaff || !flags || mutation.isPending || !!flags.is_controlled
          }
          onChange={(e) =>
            mutation.mutate({ requires_prescription: e.currentTarget.checked })
          }
        />
        <Switch
          label={t`Controlled medicine`}
          description={t`Always prescription-only, and the prescription reference is mandatory.`}
          checked={!!flags?.is_controlled}
          disabled={!isStaff || !flags || mutation.isPending}
          onChange={(e) =>
            mutation.mutate({ is_controlled: e.currentTarget.checked })
          }
        />
      </Stack>
    </Card>
  );
}

import { t } from '@lingui/core/macro';
import {
  Alert,
  Button,
  Card,
  Divider,
  NumberInput,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { api } from '../../App';
import { useUserState } from '../../states/UserState';

type Medicine = {
  requires_prescription: boolean;
  is_controlled: boolean;
  brand: string;
  generic_name: string;
  strength: string;
  description: string;
  manufacturer: string;
  mrp: string | null;
};

type Details = {
  brand: string;
  generic_name: string;
  strength: string;
  description: string;
  manufacturer: string;
  mrp: number | '';
};

function toDetails(m: Medicine | undefined): Details {
  return {
    brand: m?.brand ?? '',
    generic_name: m?.generic_name ?? '',
    strength: m?.strength ?? '',
    description: m?.description ?? '',
    manufacturer: m?.manufacturer ?? '',
    mrp: m?.mrp ? Number(m.mrp) : ''
  };
}

/**
 * Pharmacy details for one medicine, with the same labels as the New
 * Medicine form and the Medicines table: Brand, Generic Name, Strength,
 * Description, Manufacturer, MRP. Changing Brand or Strength renames the
 * medicine everywhere ("Nico 500 mg").
 *
 * Also the prescription flags: prescription-only medicines cannot be sold
 * over the counter (the New Sale form and the API both enforce it);
 * controlled medicines additionally need the prescription reference. A
 * controlled medicine is always prescription-only. Staff / admin only.
 */
export default function MedicineFlagsPanel({
  partId,
  onRenamed
}: Readonly<{ partId: number; onRenamed?: () => void }>) {
  const queryClient = useQueryClient();
  const user = useUserState();
  const isStaff = user.isStaff() || user.isSuperuser();
  const url = `/plugin/nexainventory/medicine/${partId}/`;

  const query = useQuery({
    queryKey: ['nexa-medicine', partId],
    queryFn: async () => (await api.get<Medicine>(url)).data
  });

  const [details, setDetails] = useState<Details>(toDetails(undefined));
  useEffect(() => setDetails(toDetails(query.data)), [query.data]);

  const saved = toDetails(query.data);
  const changed = (Object.keys(details) as (keyof Details)[]).some(
    (k) => details[k] !== saved[k]
  );

  const mutation = useMutation({
    mutationFn: async (patch: Record<string, unknown>) =>
      (await api.put<Medicine>(url, patch)).data,
    onSuccess: (data, patch) => {
      queryClient.setQueryData(['nexa-medicine', partId], data);
      for (const key of [
        'nexa-medicine-flags',
        'nexa-medicine-details',
        'nexa-part-picker'
      ]) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
      notifications.show({ message: t`Saved`, color: 'green' });
      if ('brand' in patch || 'strength' in patch || 'description' in patch) {
        onRenamed?.();
      }
    },
    onError: (error: any) =>
      notifications.show({
        message: error?.response?.data?.detail ?? t`Could not save`,
        color: 'red'
      })
  });

  if (query.isError) {
    return (
      <Alert color='red' icon={<IconAlertCircle size={16} />}>
        {t`Could not load the pharmacy settings for this product`}
      </Alert>
    );
  }

  const flags = query.data;
  const set = (key: keyof Details) => (value: string | number) =>
    setDetails((d) => ({ ...d, [key]: value }));

  return (
    <Card withBorder maw={720}>
      <Stack>
        <Text fw={700}>{t`Product Details`}</Text>
        {!isStaff && (
          <Text size='sm' c='dimmed'>
            {t`Only an owner or admin can change these settings.`}
          </Text>
        )}
        <SimpleGrid cols={{ base: 1, xs: 2 }}>
          <TextInput
            label={t`Product`}
            value={details.brand}
            onChange={(e) => set('brand')(e.currentTarget.value)}
            disabled={!isStaff}
          />
          <TextInput
            label={t`Generic Name`}
            value={details.generic_name}
            onChange={(e) => set('generic_name')(e.currentTarget.value)}
            disabled={!isStaff}
          />
          <TextInput
            label={t`Strength`}
            value={details.strength}
            onChange={(e) => set('strength')(e.currentTarget.value)}
            disabled={!isStaff}
          />
          <TextInput
            label={t`Manufacturer`}
            value={details.manufacturer}
            onChange={(e) => set('manufacturer')(e.currentTarget.value)}
            disabled={!isStaff}
          />
          <NumberInput
            label={t`MRP (per unit)`}
            value={details.mrp}
            onChange={(v) => set('mrp')(v as number)}
            min={0}
            decimalScale={2}
            disabled={!isStaff}
          />
        </SimpleGrid>
        <TextInput
          label={t`Description`}
          value={details.description}
          onChange={(e) => set('description')(e.currentTarget.value)}
          maxLength={250}
          disabled={!isStaff}
        />
        {isStaff && (
          <Button
            style={{ alignSelf: 'flex-start' }}
            disabled={!changed || !details.brand.trim()}
            loading={mutation.isPending}
            onClick={() => {
              const patch: Record<string, unknown> = {};
              for (const key of Object.keys(details) as (keyof Details)[]) {
                if (details[key] !== saved[key]) {
                  patch[key] =
                    key === 'mrp' && details.mrp === '' ? null : details[key];
                }
              }
              mutation.mutate(patch);
            }}
          >
            {t`Save details`}
          </Button>
        )}

        <Divider label={t`Prescription control`} labelPosition='left' />
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
          label={t`Controlled product`}
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

import { t } from '@lingui/core/macro';
import {
  Alert,
  Button,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Textarea
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconAdjustments, IconAlertCircle } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { api } from '../../App';
import { formatQty } from './format';
import { ProductPicker, useBatches } from './ProductPicker';

type AdjustType = 'return' | 'expiry_writeoff';

/**
 * Customer return (puts stock back into a batch) and expiry write-off
 * (removes an expired batch from stock). Both act on one named batch, unlike
 * a sale, which takes earliest-expiring stock first.
 */
export default function AdjustStockButton({
  fullWidth
}: Readonly<{ fullWidth?: boolean }> = {}) {
  const isMobile = useMediaQuery('(max-width: 48em)');
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState(false);
  const [type, setType] = useState<AdjustType>('expiry_writeoff');
  const [partId, setPartId] = useState<number | null>(null);
  const [stockItemId, setStockItemId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState<number | ''>('');
  const [notes, setNotes] = useState('');
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const batches = useBatches(partId);

  const options = useMemo(() => {
    const rows = (batches.data ?? []).filter(
      (b) => type === 'return' || b.expired
    );
    return rows.map((b) => ({
      value: String(b.id),
      label: `${b.batch || t`(no batch)`} — ${b.expiryDate ?? t`no expiry`}${
        b.expired ? ` (${t`EXPIRED`})` : ''
      } — ${formatQty(b.quantity)}`
    }));
  }, [batches.data, type]);

  const selected = (batches.data ?? []).find((b) => String(b.id) === stockItemId);

  const reset = () => {
    setPartId(null);
    setStockItemId(null);
    setQuantity('');
    setNotes('');
    setErrorDetail(null);
  };

  const mutation = useMutation({
    mutationFn: async () => {
      setErrorDetail(null);
      return api.post('/plugin/nexainventory/record-sale/', {
        stock_item_id: Number(stockItemId),
        sale_type: type,
        quantity,
        notes
      });
    },
    onSuccess: () => {
      notifications.show({
        message: type === 'return' ? t`Return recorded` : t`Write-off recorded`,
        color: 'green'
      });
      queryClient.invalidateQueries({ queryKey: ['nexa-batches'] });
      setOpened(false);
      reset();
    },
    onError: (error: any) => {
      setErrorDetail(
        error?.response?.data?.detail ?? t`Could not record this adjustment`
      );
    }
  });

  const tooMany =
    type === 'expiry_writeoff' &&
    selected &&
    typeof quantity === 'number' &&
    quantity > selected.quantity;

  const canSubmit =
    !!stockItemId && typeof quantity === 'number' && quantity > 0 && !tooMany;

  return (
    <>
      <Button
        variant='light'
        color='gray'
        size='md'
        fullWidth={fullWidth}
        leftSection={<IconAdjustments size={18} />}
        onClick={() => setOpened(true)}
      >
        {t`Return / Write-off`}
      </Button>
      <Modal
        opened={opened}
        onClose={() => {
          setOpened(false);
          reset();
        }}
        title={t`Return / Write-off`}
        centered
        fullScreen={isMobile}
        closeOnClickOutside={false}
      >
        <Stack>
          {errorDetail && (
            <Alert color='red' icon={<IconAlertCircle size={16} />}>
              {errorDetail}
            </Alert>
          )}
          <SegmentedControl
            value={type}
            onChange={(v) => {
              setType(v as AdjustType);
              setStockItemId(null);
            }}
            data={[
              { value: 'expiry_writeoff', label: t`Expiry Write-off` },
              { value: 'return', label: t`Customer Return` }
            ]}
          />
          <ProductPicker
            value={partId}
            onChange={(id) => {
              setPartId(id);
              setStockItemId(null);
            }}
          />
          <Select
            label={type === 'return' ? t`Batch returned` : t`Expired batch`}
            data={options}
            value={stockItemId}
            onChange={setStockItemId}
            disabled={!partId}
            nothingFoundMessage={
              type === 'return'
                ? t`No batches of this medicine`
                : t`No expired batches in stock`
            }
            required
          />
          <NumberInput
            label={t`Quantity`}
            value={quantity}
            onChange={(v) => setQuantity(v as number)}
            min={0}
            required
            error={
              tooMany && selected
                ? t`More than the ${selected.quantity} in this batch`
                : undefined
            }
          />
          <Textarea
            label={t`Notes`}
            value={notes}
            onChange={(e) => setNotes(e.currentTarget.value)}
            autosize
            minRows={1}
          />
          <Button
            fullWidth
            disabled={!canSubmit}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {type === 'return' ? t`Record Return` : t`Write Off`}
          </Button>
        </Stack>
      </Modal>
    </>
  );
}

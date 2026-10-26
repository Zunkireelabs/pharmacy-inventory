import { t } from '@lingui/core/macro';
import { Alert, Button, Modal, NumberInput, Stack, Textarea } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle, IconPackageImport } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '../../App';
import { ProductPicker, StockAvailabilityHint } from './ProductPicker';

/**
 * Minimal restock quick-action, reachable from the dashboard. Restock is
 * deliberately NOT part of the customer-facing New Sale selector (it's an
 * inventory operation, not a sale) — this is its own small self-contained
 * flow using the same existing record-sale/ endpoint (sale_type=restock).
 */
export default function RestockButton({
  fullWidth
}: Readonly<{ fullWidth?: boolean }> = {}) {
  const isMobile = useMediaQuery('(max-width: 48em)');
  const [opened, setOpened] = useState(false);
  const [stockItemId, setStockItemId] = useState<number | null>(null);
  const [stockQty, setStockQty] = useState<number | null>(null);
  const [quantity, setQuantity] = useState<number | ''>('');
  const [notes, setNotes] = useState('');
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const reset = () => {
    setStockItemId(null);
    setStockQty(null);
    setQuantity('');
    setNotes('');
    setErrorDetail(null);
  };

  const mutation = useMutation({
    mutationFn: async () => {
      setErrorDetail(null);
      return api.post('/plugin/nexainventory/record-sale/', {
        stock_item_id: stockItemId,
        sale_type: 'restock',
        quantity,
        notes
      });
    },
    onSuccess: () => {
      notifications.show({ message: t`Stock added`, color: 'green' });
      setOpened(false);
      reset();
    },
    onError: (error: any) => {
      setErrorDetail(
        error?.response?.data?.detail ?? t`Could not add stock`
      );
    }
  });

  return (
    <>
      <Button
        variant='light'
        size='md'
        fullWidth={fullWidth}
        leftSection={<IconPackageImport size={18} />}
        onClick={() => setOpened(true)}
      >
        {t`Restock`}
      </Button>
      <Modal
        opened={opened}
        onClose={() => {
          setOpened(false);
          reset();
        }}
        title={t`Restock`}
        centered
        fullScreen={isMobile}
      >
        <Stack>
          {errorDetail && (
            <Alert color='red' icon={<IconAlertCircle size={16} />}>
              {errorDetail}
            </Alert>
          )}
          <ProductPicker
            value={stockItemId}
            onChange={(id, qty) => {
              setStockItemId(id);
              setStockQty(qty);
            }}
          />
          <StockAvailabilityHint quantity={stockQty} />
          <NumberInput
            label={t`Quantity to Add`}
            value={quantity}
            onChange={(v) => setQuantity(v as number)}
            min={0}
            required
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
            disabled={!stockItemId || !quantity || Number(quantity) <= 0}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {t`Add Stock`}
          </Button>
        </Stack>
      </Modal>
    </>
  );
}

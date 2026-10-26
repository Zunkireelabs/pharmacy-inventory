import { t } from '@lingui/core/macro';
import {
  Alert,
  Button,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  TextInput,
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
import { SLOW_REQUEST } from './slow';

type Mode = 'expiry_writeoff' | 'adjustment';

/**
 * Expiry write-off (removes an expired batch) and stock adjustment (a signed
 * change with a reason and an approver, e.g. after a stock-take). Both act on
 * one named batch. Customer returns are done from the bill itself.
 */
export default function AdjustStockButton({
  fullWidth
}: Readonly<{ fullWidth?: boolean }> = {}) {
  const isMobile = useMediaQuery('(max-width: 48em)');
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState(false);
  const [mode, setMode] = useState<Mode>('expiry_writeoff');
  const [partId, setPartId] = useState<number | null>(null);
  const [stockItemId, setStockItemId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState<number | ''>('');
  const [reason, setReason] = useState('');
  const [approvedBy, setApprovedBy] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const batches = useBatches(partId);
  const isWriteoff = mode === 'expiry_writeoff';

  const options = useMemo(() => {
    const rows = (batches.data ?? []).filter((b) => !isWriteoff || b.expired);
    return rows.map((b) => ({
      value: String(b.id),
      label: `${b.batch || t`(no batch)`} — ${b.expiryDate ?? t`no expiry`}${
        b.expired ? ` (${t`EXPIRED`})` : ''
      } — ${formatQty(b.quantity)}`
    }));
  }, [batches.data, isWriteoff]);

  const selected = (batches.data ?? []).find((b) => String(b.id) === stockItemId);

  const reset = () => {
    setPartId(null);
    setStockItemId(null);
    setQuantity('');
    setReason('');
    setApprovedBy('');
    setReference('');
    setNotes('');
    setErrorDetail(null);
  };

  const mutation = useMutation({
    mutationFn: async () => {
      setErrorDetail(null);
      if (isWriteoff) {
        return api.post('/plugin/nexainventory/record-sale/', {
          stock_item_id: Number(stockItemId),
          sale_type: 'expiry_writeoff',
          quantity,
          notes: reason || notes
        }, SLOW_REQUEST);
      }
      return api.post('/plugin/nexainventory/adjust-stock/', {
        stock_item_id: Number(stockItemId),
        quantity_change: quantity,
        reason: reason.trim(),
        approved_by: approvedBy.trim(),
        reference_no: reference.trim(),
        remarks: notes
      }, SLOW_REQUEST);
    },
    onSuccess: () => {
      notifications.show({
        message: isWriteoff ? t`Write-off recorded` : t`Adjustment recorded`,
        color: 'green'
      });
      queryClient.invalidateQueries({ queryKey: ['nexa-batches'] });
      queryClient.invalidateQueries({ queryKey: ['nexa-dashboard-expiry'] });
      setOpened(false);
      reset();
    },
    onError: (error: any) => {
      setErrorDetail(
        error?.response?.data?.detail ?? t`Could not record this change`
      );
    }
  });

  const qty = typeof quantity === 'number' ? quantity : 0;
  const tooMany =
    !!selected && (isWriteoff ? qty > selected.quantity : -qty > selected.quantity);

  const canSubmit =
    !!stockItemId &&
    qty !== 0 &&
    (!isWriteoff || qty > 0) &&
    !tooMany &&
    (isWriteoff || (!!reason.trim() && !!approvedBy.trim()));

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
        {t`Adjust / Write-off`}
      </Button>
      <Modal
        opened={opened}
        onClose={() => {
          setOpened(false);
          reset();
        }}
        title={t`Adjust / Write-off`}
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
            value={mode}
            onChange={(v) => {
              setMode(v as Mode);
              setStockItemId(null);
              setQuantity('');
            }}
            data={[
              { value: 'expiry_writeoff', label: t`Expiry Write-off` },
              { value: 'adjustment', label: t`Stock Adjustment` }
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
            label={isWriteoff ? t`Expired batch` : t`Batch`}
            data={options}
            value={stockItemId}
            onChange={setStockItemId}
            disabled={!partId}
            nothingFoundMessage={
              isWriteoff ? t`No expired batches in stock` : t`No batches of this medicine`
            }
            required
          />
          <NumberInput
            label={isWriteoff ? t`Quantity to write off` : t`Quantity change (+ add, − remove)`}
            value={quantity}
            onChange={(v) => setQuantity(v as number)}
            allowNegative={!isWriteoff}
            required
            error={
              tooMany && selected
                ? t`More than the ${selected.quantity} in this batch`
                : undefined
            }
          />
          {!isWriteoff && (
            <>
              <TextInput
                label={t`Reason`}
                placeholder={t`Stock-take difference, damage, breakage...`}
                value={reason}
                onChange={(e) => setReason(e.currentTarget.value)}
                required
              />
              <TextInput
                label={t`Approved By`}
                value={approvedBy}
                onChange={(e) => setApprovedBy(e.currentTarget.value)}
                required
              />
              <TextInput
                label={t`Reference No.`}
                value={reference}
                onChange={(e) => setReference(e.currentTarget.value)}
              />
            </>
          )}
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
            {isWriteoff ? t`Write Off` : t`Record Adjustment`}
          </Button>
        </Stack>
      </Modal>
    </>
  );
}

import { t } from '@lingui/core/macro';
import {
  Alert,
  Button,
  Group,
  Loader,
  Modal,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconPrinter } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api } from '../../App';
import { formatMoney, formatQty } from '../../components/nexa/format';
import { SLOW_REQUEST } from '../../components/nexa/slow';

type Bill = {
  id: number;
  reference: string;
  created_at: string;
  branch: string;
  header: {
    pharmacy_name: string;
    pharmacy_address: string;
    pharmacy_pan: string;
    pharmacy_dda_reg: string;
    pharmacy_phone: string;
    bill_footer: string;
  };
  customer: { name: string; address: string; phone: string; pan: string };
  prescriber: string;
  prescription_ref: string;
  payment_mode: string;
  lines: {
    sn: number;
    movement_id: number;
    returned_quantity: string;
    particulars: string;
    brand: string;
    batch: string;
    expiry_date: string | null;
    quantity: string;
    rate: string;
    amount: string;
  }[];
  subtotal: string;
  discount: string;
  discount_reason: string;
  net_amount: string;
  amount_in_words: string;
  dispensed_by: string;
};

const PAYMENT_LABEL: Record<string, string> = {
  cash: 'Cash',
  online: 'Online',
  qr: 'QR',
  other: 'Other'
};

// Print only the bill, not the app chrome around it
const PRINT_CSS = `
@page { size: A4; margin: 0; }
@media print {
  body * { visibility: hidden !important; }
  #nexa-bill, #nexa-bill * { visibility: visible !important; }
  #nexa-bill { position: absolute; left: 0; top: 0; width: 100%; max-width: none !important; box-sizing: border-box; padding: 14mm !important; box-shadow: none !important; border: none !important; }
  .nexa-no-print { display: none !important; }
}
`;

type BillLine = Bill['lines'][number];

/** Return part of one bill line: refunds it and, if resalable, restocks the batch. */
function ReturnDialog({
  line,
  onClose,
  onDone
}: Readonly<{ line: BillLine | null; onClose: () => void; onDone: () => void }>) {
  const [quantity, setQuantity] = useState<number | ''>('');
  const [reason, setReason] = useState('');
  const [disposition, setDisposition] = useState('resalable');
  const [error, setError] = useState<string | null>(null);

  const remaining = line ? Number(line.quantity) - Number(line.returned_quantity) : 0;

  const mutation = useMutation({
    mutationFn: async () =>
      api.post('/plugin/nexainventory/sales-return/', {
        movement_id: line?.movement_id,
        quantity,
        reason: reason.trim(),
        disposition
      }, SLOW_REQUEST),
    onSuccess: (response) => {
      notifications.show({
        message: t`Return ${response.data.reference} recorded — refund ${response.data.refund_amount}`,
        color: 'green'
      });
      setQuantity('');
      setReason('');
      setError(null);
      onDone();
    },
    onError: (e: any) =>
      setError(e?.response?.data?.detail ?? t`Could not record the return`)
  });

  const qty = typeof quantity === 'number' ? quantity : 0;

  return (
    <Modal opened={!!line} onClose={onClose} title={t`Return items`} centered>
      {line && (
        <Stack>
          {error && <Alert color='red'>{error}</Alert>}
          <Text size='sm'>
            {line.particulars} — {t`batch`} {line.batch || '-'} — {t`up to`} {remaining}
          </Text>
          <NumberInput
            label={t`Quantity returned`}
            value={quantity}
            onChange={(v) => setQuantity(v as number)}
            min={0}
            max={remaining}
            required
          />
          <TextInput
            label={t`Reason`}
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
            required
          />
          <Select
            label={t`Stock disposition`}
            data={[
              { value: 'resalable', label: t`Resalable — back to stock` },
              { value: 'not_resalable', label: t`Not resalable — damaged / expired` }
            ]}
            value={disposition}
            onChange={(v) => setDisposition(v ?? 'resalable')}
            allowDeselect={false}
          />
          <Text size='sm' c='dimmed'>
            {t`Refund`}: {formatMoney(qty * Number(line.rate))}
          </Text>
          <Button
            disabled={qty <= 0 || qty > remaining || !reason.trim()}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {t`Record Return`}
          </Button>
        </Stack>
      )}
    </Modal>
  );
}

const cell = { border: '1px solid #444', padding: '4px 8px' } as const;

/** Customer bill, laid out like the pharmacy's patient bill, ready to print. */
export default function BillPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const queryClient = useQueryClient();
  const [returning, setReturning] = useState<BillLine | null>(null);

  const query = useQuery({
    queryKey: ['nexa-bill', id],
    queryFn: async () =>
      (await api.get<Bill>(`/plugin/nexainventory/bills/${id}/`)).data
  });

  if (query.isLoading) return <Loader />;
  if (query.isError || !query.data) {
    return <Alert color='red'>{t`Bill not found`}</Alert>;
  }

  const bill = query.data;
  const h = bill.header;
  const hasDiscount = Number(bill.discount) > 0;

  return (
    <Stack gap='md'>
      <style>{PRINT_CSS}</style>
      <ReturnDialog
        line={returning}
        onClose={() => setReturning(null)}
        onDone={() => {
          setReturning(null);
          queryClient.invalidateQueries({ queryKey: ['nexa-bill', id] });
          queryClient.invalidateQueries({ queryKey: ['nexa-batches'] });
        }}
      />
      <Group className='nexa-no-print'>
        <Button
          variant='default'
          leftSection={<IconArrowLeft size={16} />}
          onClick={() => navigate('/bills/')}
        >
          {t`All Bills`}
        </Button>
        <Button leftSection={<IconPrinter size={16} />} onClick={() => window.print()}>
          {t`Print Bill`}
        </Button>
      </Group>

      <div
        id='nexa-bill'
        style={{
          background: 'white',
          color: 'black',
          maxWidth: 800,
          padding: 24,
          border: '1px solid #ccc',
          fontSize: 14,
          lineHeight: 1.4
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 22, fontWeight: 800 }}>{h.pharmacy_name}</div>
          {h.pharmacy_address && <div>{h.pharmacy_address}</div>}
          {h.pharmacy_pan && <div>PAN: {h.pharmacy_pan}</div>}
          {h.pharmacy_dda_reg && <div>DDA REG. NO.: {h.pharmacy_dda_reg}</div>}
          {h.pharmacy_phone && <div>Phone No.: {h.pharmacy_phone}</div>}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <div>
            <div>Customer&apos;s name: {bill.customer.name}</div>
            <div>Customer&apos;s Address: {bill.customer.address}</div>
            <div>Contact No: {bill.customer.phone}</div>
            <div>Customer&apos;s PAN: {bill.customer.pan}</div>
            {bill.prescriber && <div>Prescribed By: {bill.prescriber}</div>}
            {bill.prescription_ref && <div>Prescription No: {bill.prescription_ref}</div>}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontWeight: 700 }}>Bill No: {bill.reference}</div>
            <div>{new Date(bill.created_at).toLocaleString('en-GB')}</div>
            {bill.branch && <div>Branch: {bill.branch}</div>}
            <div>Mode of Payment: {PAYMENT_LABEL[bill.payment_mode] ?? bill.payment_mode}</div>
          </div>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['SN.', 'Particulars', 'Batch No.', 'Expiry Date', 'Quantity', 'Rate', 'Amount'].map(
                (head) => (
                  <th key={head} style={{ ...cell, textAlign: 'left' }}>
                    {head}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {bill.lines.map((l) => (
              <tr key={l.sn}>
                <td style={cell}>{l.sn}</td>
                <td style={cell}>{l.particulars}</td>
                <td style={cell}>{l.batch}</td>
                <td style={cell}>{l.expiry_date ?? ''}</td>
                <td style={{ ...cell, textAlign: 'right' }}>
                  {formatQty(l.quantity)}
                  {Number(l.returned_quantity) > 0 && (
                    <div style={{ fontSize: 11 }}>
                      (returned {formatQty(l.returned_quantity)})
                    </div>
                  )}
                  {Number(l.returned_quantity) < Number(l.quantity) && (
                    <Button
                      className='nexa-no-print'
                      size='compact-xs'
                      variant='subtle'
                      onClick={() => setReturning(l)}
                    >
                      {t`Return`}
                    </Button>
                  )}
                </td>
                <td style={{ ...cell, textAlign: 'right' }}>{formatMoney(l.rate)}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{formatMoney(l.amount)}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={5} style={{ ...cell, border: 'none' }} />
              <td style={{ ...cell, textAlign: 'right' }}>Sub total</td>
              <td style={{ ...cell, textAlign: 'right' }}>{formatMoney(bill.subtotal)}</td>
            </tr>
            <tr>
              <td colSpan={5} style={{ ...cell, border: 'none' }}>
                {hasDiscount && bill.discount_reason
                  ? `Discount reason: ${bill.discount_reason}`
                  : ''}
              </td>
              <td style={{ ...cell, textAlign: 'right' }}>Discount</td>
              <td style={{ ...cell, textAlign: 'right' }}>{formatMoney(bill.discount)}</td>
            </tr>
            <tr>
              <td colSpan={5} style={{ ...cell, border: 'none' }}>
                Amount in words: {bill.amount_in_words}
              </td>
              <td style={{ ...cell, textAlign: 'right', fontWeight: 700 }}>Net Amount</td>
              <td style={{ ...cell, textAlign: 'right', fontWeight: 700 }}>
                {formatMoney(bill.net_amount)}
              </td>
            </tr>
          </tbody>
        </table>

        <div style={{ marginTop: 8 }}>E. &amp; O. E.</div>
        {h.bill_footer && <div style={{ marginTop: 8, fontSize: 12 }}>{h.bill_footer}</div>}

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: 40,
            fontSize: 13
          }}
        >
          <div>Customer&apos;s Signature</div>
          <div>Dispensed By: {bill.dispensed_by}</div>
          <div>Authorized signature</div>
        </div>
      </div>
    </Stack>
  );
}

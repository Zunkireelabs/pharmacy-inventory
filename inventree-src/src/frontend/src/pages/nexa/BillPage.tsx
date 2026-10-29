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
import { formatExpiry, formatMoney, formatQty } from '../../components/nexa/format';
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
    bill_title: string;
    pharmacist_npc_no: string;
    bill_footer: string;
  };
  date_bs: string;
  date_ad: string;
  time: string;
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
  rounding: string;
  amount_in_words: string;
  dispensed_by: string;
};

const PAYMENT_LABEL: Record<string, string> = {
  cash: 'Cash',
  online: 'Online',
  qr: 'QR',
  other: 'Other'
};

// Print only the bill, not the app chrome around it. A5 (half A4), the
// size of the pharmacy's paper bills.
const PRINT_CSS = `
@page { size: A5 portrait; margin: 6mm; }
@media print {
  body * { visibility: hidden !important; }
  #nexa-bill, #nexa-bill * { visibility: visible !important; }
  #nexa-bill { position: absolute; left: 0; top: 0; width: 100%; max-width: none !important; box-sizing: border-box; padding: 0 !important; box-shadow: none !important; border: none !important; }
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

// Printed-bill look: typewriter font and dashed rules, like dot-matrix bills
const FONT = "'Courier New', Courier, monospace";
const DASH = '1px dashed #000';
const rule = { borderTop: DASH, margin: '4px 0' } as const;
const doubleRule = { borderTop: DASH, borderBottom: DASH, height: 2, margin: '4px 0' } as const;
const th = { textAlign: 'left', fontWeight: 700, padding: '2px 4px' } as const;
const td = { padding: '2px 4px', verticalAlign: 'top' } as const;
const right = { textAlign: 'right' } as const;

/** Plain amount as on paper bills: 1,234.50 (no currency sign). */
function amt(value: string | number) {
  return Number(value).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

/** One "Label : value" line; nothing when the value is empty. */
function Info({ label, value }: Readonly<{ label: string; value?: string }>) {
  if (!value) return null;
  return (
    <div>
      {label} : {value}
    </div>
  );
}

/** Customer bill, laid out like the pharmacy's paper bills, ready to print. */
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
  const printedAt = new Date().toLocaleTimeString('en-US');
  const totalRow = (label: string, value: string, bold = false) => (
    <tr style={bold ? { fontWeight: 700 } : undefined}>
      <td style={{ ...td, ...right, width: '100%' }}>{label} :</td>
      <td style={{ ...td, ...right, whiteSpace: 'nowrap' }}>{value}</td>
    </tr>
  );

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
          maxWidth: 560,
          padding: 20,
          border: '1px solid #ccc',
          fontFamily: FONT,
          fontSize: 12,
          lineHeight: 1.35
        }}
      >
        {/* Pharmacy */}
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: 1 }}>
            {h.pharmacy_name}
          </div>
          {h.pharmacy_address && <div>{h.pharmacy_address}</div>}
          <div>
            {[
              h.pharmacy_dda_reg && `DDA No: ${h.pharmacy_dda_reg}`,
              h.pharmacy_pan && `PAN: ${h.pharmacy_pan}`
            ]
              .filter(Boolean)
              .join(' , ')}
          </div>
          {h.pharmacy_phone && <div>Phone: {h.pharmacy_phone}</div>}
          <div style={{ fontWeight: 700, marginTop: 6 }}>{h.bill_title || 'INVOICE'}</div>
        </div>

        {/* Bill and customer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 12,
            marginTop: 8
          }}
        >
          <div>
            <Info label='Invoice No.' value={bill.reference} />
            <Info label='Name' value={bill.customer.name} />
            <Info label='Add' value={bill.customer.address} />
            <Info label='Contact' value={bill.customer.phone} />
            <Info label='PAN' value={bill.customer.pan} />
            <Info label='Prescribed By' value={bill.prescriber} />
            <Info label='NMC No.' value={bill.prescription_ref} />
          </div>
          <div style={{ textAlign: 'right' }}>
            <Info label='Date (B.S.)' value={bill.date_bs} />
            <Info label='Date (A.D.)' value={bill.date_ad} />
            <Info label='Time' value={bill.time} />
            <Info label='Branch' value={bill.branch} />
            <Info
              label='Payment Mode'
              value={PAYMENT_LABEL[bill.payment_mode] ?? bill.payment_mode}
            />
          </div>
        </div>

        {/* Medicines */}
        <div style={doubleRule} />
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={th}>Sn.</th>
              <th style={th}>Particular</th>
              <th style={th}>Batch</th>
              <th style={th}>Expiry</th>
              <th style={{ ...th, ...right }}>Qty</th>
              <th style={{ ...th, ...right }}>Rate</th>
              <th style={{ ...th, ...right }}>Amount</th>
            </tr>
            <tr>
              <td colSpan={7} style={{ padding: 0 }}>
                <div style={rule} />
              </td>
            </tr>
          </thead>
          <tbody>
            {bill.lines.map((l) => (
              <tr key={l.sn}>
                <td style={td}>{l.sn}.</td>
                <td style={td}>{l.particulars}</td>
                <td style={td}>{l.batch}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{formatExpiry(l.expiry_date)}</td>
                <td style={{ ...td, ...right }}>
                  {formatQty(l.quantity)}
                  {Number(l.returned_quantity) > 0 && (
                    <div style={{ fontSize: 10 }}>
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
                <td style={{ ...td, ...right }}>{amt(l.rate)}</td>
                <td style={{ ...td, ...right }}>{amt(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={rule} />

        {/* Totals */}
        <table style={{ marginLeft: 'auto', borderCollapse: 'collapse', fontSize: 12 }}>
          <tbody>
            {totalRow('TOTAL', amt(bill.subtotal))}
            {totalRow('DISCOUNT', amt(bill.discount))}
            {totalRow('ROUNDING', amt(bill.rounding))}
            <tr>
              <td />
              <td style={{ padding: 0 }}>
                <div style={rule} />
              </td>
            </tr>
            {totalRow('NET AMOUNT', amt(bill.net_amount), true)}
            <tr>
              <td />
              <td style={{ padding: 0 }}>
                <div style={doubleRule} />
              </td>
            </tr>
          </tbody>
        </table>
        {Number(bill.discount) > 0 && bill.discount_reason && (
          <div>Discount reason : {bill.discount_reason}</div>
        )}

        <div style={{ marginTop: 6, fontWeight: 700 }}>CUSTOMER COPY</div>
        <div>In Words : {bill.amount_in_words.toUpperCase()}.</div>
        <div style={rule} />

        {/* Footer */}
        {h.bill_footer && <div>{h.bill_footer}</div>}
        <div>E. &amp; O. E.</div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            gap: 12,
            marginTop: 28
          }}
        >
          <div>Received By : ____________</div>
          <div style={{ textAlign: 'right' }}>
            <div>Dispensed By : {bill.dispensed_by}</div>
            {h.pharmacist_npc_no && <div>NPC No. : {h.pharmacist_npc_no}</div>}
            <div>Printed : {printedAt}</div>
          </div>
        </div>
      </div>
    </Stack>
  );
}

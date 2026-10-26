"""API endpoints for recording sale-type-tagged stock movements and
managing B2B receivables (invoices/payments).
"""

from datetime import date, timedelta
from decimal import Decimal, InvalidOperation

from django.db import transaction
from django.db.models import Count, Q, Sum
from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from company.models import Company
from part.models import Part
from stock.models import StockItem, StockLocation

from .models import (
    Invoice,
    InvoiceLineItem,
    MedicineInfo,
    Payment,
    PurchaseReceipt,
    SaleBill,
    SalesReturn,
    SaleTypeMovement,
    StockAdjustment,
)
from .services import (
    OUTBOUND_TYPES,
    SELLING_TYPES,
    SaleRecordingError,
    SaleValidationError,
    amount_in_words,
    check_prescription_rules,
    pharmacy_header,
    plain_quantity,
    record_sale_movement,
    resolve_allocations,
)


def _parse_branch(data):
    """Optional branch_id: a top-level stock location. Returns (branch, error)."""
    raw = data.get('branch_id')
    if raw in (None, ''):
        return None, None
    try:
        return StockLocation.objects.get(pk=raw, parent=None), None
    except (StockLocation.DoesNotExist, ValueError, TypeError):
        return None, Response(
            {'detail': 'branch_id must be a top-level stock location (branch)'},
            status=status.HTTP_400_BAD_REQUEST,
        )


def _parse_date_range(params):
    """Parse optional date_from/date_to query params (ISO YYYY-MM-DD).

    Returns (date_from, date_to, error_response). error_response is None on
    success; if set, the caller should return it immediately.
    """
    date_from = date_to = None

    raw_from = params.get('date_from')
    if raw_from:
        try:
            date_from = date.fromisoformat(raw_from)
        except ValueError:
            return None, None, Response(
                {'detail': 'Invalid date_from'}, status=status.HTTP_400_BAD_REQUEST
            )

    raw_to = params.get('date_to')
    if raw_to:
        try:
            date_to = date.fromisoformat(raw_to)
        except ValueError:
            return None, None, Response(
                {'detail': 'Invalid date_to'}, status=status.HTTP_400_BAD_REQUEST
            )

    if date_from and date_to and date_from > date_to:
        return None, None, Response(
            {'detail': 'date_from must not be after date_to'}, status=status.HTTP_400_BAD_REQUEST
        )

    return date_from, date_to, None


class RecordSaleView(APIView):
    """POST body: stock_item_id OR part_id, sale_type, quantity, unit_value
    (optional, default 0), customer_id (required for b2b_credit), notes
    (optional).

    With part_id (outbound sale types only) stock is taken earliest-expiry
    first across the part's batches, skipping expired ones, and one movement
    is recorded per batch used. With stock_item_id the named batch is used
    (and rejected if it has expired).
    """

    permission_classes = [IsAuthenticated]

    def post(self, request):
        data = request.data

        sale_type = data.get('sale_type')
        if sale_type not in SaleTypeMovement.SaleType.values:
            return Response({'detail': 'Invalid sale_type'}, status=status.HTTP_400_BAD_REQUEST)

        branch, error = _parse_branch(data)
        if error:
            return error

        stock_item = part = None
        if data.get('stock_item_id') in (None, '') and data.get('part_id') not in (None, ''):
            if sale_type not in SELLING_TYPES:
                return Response(
                    {'detail': 'part_id is only supported for sale types that sell stock'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            try:
                part = Part.objects.get(pk=data.get('part_id'))
            except (Part.DoesNotExist, ValueError, TypeError):
                return Response(
                    {'detail': 'part_id must reference an existing part'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        else:
            try:
                stock_item = StockItem.objects.get(pk=data.get('stock_item_id'))
            except (StockItem.DoesNotExist, ValueError, TypeError):
                return Response(
                    {
                        'detail': 'stock_item_id (or part_id) is required and must reference '
                        'an existing stock item'
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )

        try:
            quantity = Decimal(str(data.get('quantity')))
            if quantity <= 0:
                raise InvalidOperation
        except (InvalidOperation, TypeError):
            return Response(
                {'detail': 'quantity must be a positive number'}, status=status.HTTP_400_BAD_REQUEST
            )

        try:
            unit_value = Decimal(str(data.get('unit_value', 0)))
        except InvalidOperation:
            return Response({'detail': 'Invalid unit_value'}, status=status.HTTP_400_BAD_REQUEST)

        customer = None
        if sale_type == SaleTypeMovement.SaleType.B2B_CREDIT:
            customer_id = data.get('customer_id')
            if not customer_id:
                return Response(
                    {'detail': 'customer_id is required for b2b_credit'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            try:
                customer = Company.objects.get(pk=customer_id, is_customer=True)
            except (Company.DoesNotExist, ValueError, TypeError):
                return Response({'detail': 'Invalid customer_id'}, status=status.HTTP_400_BAD_REQUEST)

        if sale_type in OUTBOUND_TYPES and stock_item is not None and stock_item.quantity < quantity:
            return Response(
                {'detail': 'Insufficient stock for this movement'}, status=status.HTTP_400_BAD_REQUEST
            )

        try:
            with transaction.atomic():
                prescriber = (data.get('prescriber') or '').strip()
                prescription_ref = (data.get('prescription_ref') or '').strip()
                check_prescription_rules(
                    part or stock_item.part, sale_type, prescriber, prescription_ref
                )

                if sale_type in SELLING_TYPES:
                    allocations = resolve_allocations(
                        stock_item=stock_item, part=part, quantity=quantity, branch=branch
                    )
                else:
                    allocations = [(stock_item, quantity)]

                movements = [
                    record_sale_movement(
                        stock_item=item,
                        sale_type=sale_type,
                        quantity=qty,
                        unit_value=unit_value,
                        customer=customer,
                        user=request.user,
                        notes=data.get('notes', ''),
                        prescriber=prescriber,
                        prescription_ref=prescription_ref,
                    )
                    for item, qty in allocations
                ]
        except SaleValidationError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except SaleRecordingError:
            return Response({'detail': 'Stock update failed'}, status=status.HTTP_400_BAD_REQUEST)

        return Response(
            {
                'id': movements[0].id,
                'movement_ids': [m.id for m in movements],
                'allocations': [
                    {
                        'stock_item_id': item.pk,
                        'batch': item.batch,
                        'expiry_date': item.expiry_date.isoformat() if item.expiry_date else None,
                        'quantity': plain_quantity(qty),
                    }
                    for item, qty in allocations
                ],
            },
            status=status.HTTP_201_CREATED,
        )


DEFAULT_DUE_DAYS = 30


def _parse_line_items(raw_items):
    """Validate and parse the `items` array shared by RecordB2BSaleView.

    Returns (parsed_items, error_response). parsed_items is a list of dicts
    with keys stock_item (StockItem instance, or None when the line gives a
    part_id for earliest-expiry-first allocation), part (Part or None),
    quantity (Decimal), unit_value (Decimal). error_response is None on
    success.
    """
    if not isinstance(raw_items, list) or not raw_items:
        return None, Response(
            {'detail': 'items must be a non-empty array'}, status=status.HTTP_400_BAD_REQUEST
        )

    parsed = []
    for raw in raw_items:
        stock_item = part = None
        try:
            if raw.get('stock_item_id') in (None, '') and raw.get('part_id') not in (None, ''):
                part = Part.objects.get(pk=raw.get('part_id'))
            else:
                stock_item = StockItem.objects.get(pk=raw.get('stock_item_id'))
        except (StockItem.DoesNotExist, Part.DoesNotExist, ValueError, TypeError, AttributeError):
            return None, Response(
                {'detail': 'Each item requires a valid stock_item_id or part_id'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            quantity = Decimal(str(raw.get('quantity')))
            if quantity <= 0:
                raise InvalidOperation
        except (InvalidOperation, TypeError):
            return None, Response(
                {'detail': 'Each item requires a positive quantity'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            unit_value = Decimal(str(raw.get('unit_value', 0)))
        except InvalidOperation:
            return None, Response(
                {'detail': 'Invalid unit_value'}, status=status.HTTP_400_BAD_REQUEST
            )

        if stock_item is not None and stock_item.quantity < quantity:
            return None, Response(
                {'detail': f'Insufficient stock for {stock_item.part.name}'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        parsed.append({
            'stock_item': stock_item,
            'part': part,
            'quantity': quantity,
            'unit_value': unit_value,
        })

    return parsed, None


class RecordB2BSaleView(APIView):
    """POST body: items (required, non-empty array of {stock_item_id or
    part_id, quantity, unit_value}; part_id lines are filled earliest-expiry
    first and may span several batches), customer_id (required, must be an
    is_customer=True Company), due_date (optional, ISO date string;
    defaults to today + 30 days), notes (optional, applied to every line's
    underlying stock movement).

    Atomically: reduces stock and creates a b2b_credit SaleTypeMovement for
    every item, creates one Invoice, creates one InvoiceLineItem per
    movement. All-or-nothing across every line.
    """

    permission_classes = [IsAuthenticated]

    def post(self, request):
        data = request.data

        items, error = _parse_line_items(data.get('items'))
        if error:
            return error

        branch, error = _parse_branch(data)
        if error:
            return error

        customer_id = data.get('customer_id')
        if not customer_id:
            return Response({'detail': 'customer_id is required'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            customer = Company.objects.get(pk=customer_id, is_customer=True)
        except (Company.DoesNotExist, ValueError, TypeError):
            return Response({'detail': 'Invalid customer_id'}, status=status.HTTP_400_BAD_REQUEST)

        due_date_raw = data.get('due_date')
        if due_date_raw:
            try:
                due_date = date.fromisoformat(due_date_raw)
            except ValueError:
                return Response({'detail': 'Invalid due_date'}, status=status.HTTP_400_BAD_REQUEST)
        else:
            due_date = timezone.localdate() + timedelta(days=DEFAULT_DUE_DAYS)

        notes = data.get('notes', '')

        try:
            with transaction.atomic():
                movements = [
                    record_sale_movement(
                        stock_item=batch,
                        sale_type=SaleTypeMovement.SaleType.B2B_CREDIT,
                        quantity=qty,
                        unit_value=item['unit_value'],
                        customer=customer,
                        user=request.user,
                        notes=notes,
                    )
                    for item in items
                    for batch, qty in resolve_allocations(
                        stock_item=item['stock_item'],
                        part=item['part'],
                        quantity=item['quantity'],
                        branch=branch,
                    )
                ]
                invoice = Invoice.objects.create(
                    customer=customer,
                    due_date=due_date,
                    total=sum((m.total_value for m in movements), Decimal('0')),
                    created_by=request.user,
                )
                InvoiceLineItem.objects.bulk_create([
                    InvoiceLineItem(invoice=invoice, sale_type_movement=m) for m in movements
                ])
        except SaleValidationError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except SaleRecordingError:
            return Response({'detail': 'Stock update failed'}, status=status.HTTP_400_BAD_REQUEST)

        return Response(
            {
                'invoice_id': invoice.id,
                'reference': invoice.reference,
                'total': str(invoice.total),
                'outstanding': str(invoice.outstanding),
                'status': invoice.status,
                'line_count': len(movements),
            },
            status=status.HTTP_201_CREATED,
        )


class InvoicePaymentsView(APIView):
    """GET: chronological payment history for one invoice.
    POST body: amount, method (cash/online/cheque), payment_date (optional,
    ISO date, defaults to today), reference (optional).
    """

    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        try:
            invoice = Invoice.objects.get(pk=pk)
        except Invoice.DoesNotExist:
            return Response({'detail': 'Invoice not found'}, status=status.HTTP_404_NOT_FOUND)

        payments = invoice.payments.order_by('payment_date', 'created_at')
        return Response([
            {
                'id': p.id,
                'amount': str(p.amount),
                'payment_date': p.payment_date.isoformat(),
                'method': p.method,
                'reference': p.reference,
                'recorded_by': p.recorded_by_id,
                'created_at': p.created_at.isoformat(),
            }
            for p in payments
        ])

    def post(self, request, pk):
        data = request.data

        with transaction.atomic():
            try:
                invoice = Invoice.objects.select_for_update().get(pk=pk)
            except Invoice.DoesNotExist:
                return Response({'detail': 'Invoice not found'}, status=status.HTTP_404_NOT_FOUND)

            if invoice.status == Invoice.Status.CANCELLED:
                return Response(
                    {'detail': 'Cannot record a payment against a cancelled invoice'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            try:
                amount = Decimal(str(data.get('amount')))
            except (InvalidOperation, TypeError):
                return Response({'detail': 'Invalid amount'}, status=status.HTTP_400_BAD_REQUEST)

            if amount <= 0:
                return Response(
                    {'detail': 'amount must be greater than zero'}, status=status.HTTP_400_BAD_REQUEST
                )

            method = data.get('method')
            if method not in Payment.Method.values:
                return Response({'detail': 'Invalid method'}, status=status.HTTP_400_BAD_REQUEST)

            if amount > invoice.outstanding:
                return Response(
                    {'detail': 'Payment exceeds outstanding balance'}, status=status.HTTP_400_BAD_REQUEST
                )

            payment_date_raw = data.get('payment_date')
            if payment_date_raw:
                try:
                    payment_date = date.fromisoformat(payment_date_raw)
                except ValueError:
                    return Response({'detail': 'Invalid payment_date'}, status=status.HTTP_400_BAD_REQUEST)
            else:
                payment_date = timezone.localdate()

            payment = Payment.objects.create(
                invoice=invoice,
                amount=amount,
                payment_date=payment_date,
                method=method,
                reference=data.get('reference', ''),
                recorded_by=request.user,
            )
            invoice.refresh_status()

        return Response(
            {
                'payment_id': payment.id,
                'invoice_status': invoice.status,
                'outstanding': str(invoice.outstanding),
            },
            status=status.HTTP_201_CREATED,
        )


class InvoiceListView(APIView):
    """GET: minimal read-only list of all invoices, for a global
    invoice/receivables list screen. No filtering yet (per scope) — the
    Receivables report endpoint already covers portfolio-wide aggregation;
    this just lists individual invoices.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        invoices = Invoice.objects.select_related('customer').all()

        return Response([
            {
                'id': inv.id,
                'reference': inv.reference,
                'customer_id': inv.customer_id,
                'customer_name': inv.customer.name,
                'invoice_date': inv.invoice_date.isoformat(),
                'due_date': inv.due_date.isoformat(),
                'total': str(inv.total),
                'amount_paid': str(inv.amount_paid),
                'outstanding': str(inv.outstanding),
                'status': inv.status,
                'is_overdue': inv.is_overdue,
                'aging_bucket': inv.aging_bucket,
            }
            for inv in invoices
        ])


class InvoiceDetailView(APIView):
    """GET: full detail for one invoice, including lines and computed
    outstanding/aging.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        try:
            invoice = Invoice.objects.get(pk=pk)
        except Invoice.DoesNotExist:
            return Response({'detail': 'Invoice not found'}, status=status.HTTP_404_NOT_FOUND)

        return Response({
            'id': invoice.id,
            'reference': invoice.reference,
            'customer_id': invoice.customer_id,
            'invoice_date': invoice.invoice_date.isoformat(),
            'due_date': invoice.due_date.isoformat(),
            'total': str(invoice.total),
            'amount_paid': str(invoice.amount_paid),
            'outstanding': str(invoice.outstanding),
            'status': invoice.status,
            'is_overdue': invoice.is_overdue,
            'aging_bucket': invoice.aging_bucket,
            'lines': [
                {
                    'id': line.id,
                    'sale_type_movement_id': line.sale_type_movement_id,
                    'quantity': str(line.quantity),
                    'unit_price': str(line.unit_price),
                    'line_total': str(line.line_total),
                }
                for line in invoice.lines.all()
            ],
        })


class CustomerReceivablesView(APIView):
    """GET: outstanding receivables summary for one customer. Only
    non-cancelled invoices with outstanding > 0 contribute to the total.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        try:
            customer = Company.objects.get(pk=pk, is_customer=True)
        except Company.DoesNotExist:
            return Response({'detail': 'Customer not found'}, status=status.HTTP_404_NOT_FOUND)

        invoices = Invoice.objects.filter(customer=customer).exclude(status=Invoice.Status.CANCELLED)

        outstanding_invoices = [inv for inv in invoices if inv.outstanding > 0]
        total_outstanding = sum((inv.outstanding for inv in outstanding_invoices), Decimal('0'))

        return Response({
            'customer_id': customer.id,
            'total_outstanding': str(total_outstanding),
            'invoices': [
                {
                    'id': inv.id,
                    'reference': inv.reference,
                    'total': str(inv.total),
                    'outstanding': str(inv.outstanding),
                    'status': inv.status,
                    'due_date': inv.due_date.isoformat(),
                    'aging_bucket': inv.aging_bucket,
                }
                for inv in outstanding_invoices
            ],
        })


SALES_REPORT_TYPES = [
    SaleTypeMovement.SaleType.B2B_CREDIT,
    SaleTypeMovement.SaleType.B2C_CASH,
    SaleTypeMovement.SaleType.B2C_ONLINE,
    SaleTypeMovement.SaleType.PRESCRIPTION,
]


class SalesSummaryReportView(APIView):
    """GET: aggregate sales totals (b2b_credit/b2c_cash/b2c_online only —
    restock/correction are never sales) over an optional date range.

    Date filtering is on SaleTypeMovement.created_at (the sale event date).
    'transaction_value' is the booked value at time of sale for all three
    types. 'collected_value' is how much has actually been paid, as of now:
    equal to transaction_value for b2c_cash/b2c_online (no Invoice/Payment
    machinery exists for those types — paid at point of sale by
    construction), and the sum of real Payment rows against the linked
    invoices for b2b_credit.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        date_from, date_to, error = _parse_date_range(request.query_params)
        if error:
            return error

        movements = SaleTypeMovement.objects.filter(sale_type__in=SALES_REPORT_TYPES)
        if date_from:
            movements = movements.filter(created_at__date__gte=date_from)
        if date_to:
            movements = movements.filter(created_at__date__lte=date_to)

        by_type = {
            row['sale_type']: row
            for row in movements.values('sale_type').annotate(
                count=Count('id'), qty=Sum('quantity'), value=Sum('total_value')
            )
        }

        b2b_movement_ids = movements.filter(
            sale_type=SaleTypeMovement.SaleType.B2B_CREDIT
        ).values_list('id', flat=True)
        b2b_invoice_ids = InvoiceLineItem.objects.filter(
            sale_type_movement_id__in=b2b_movement_ids
        ).values_list('invoice_id', flat=True)
        b2b_collected = Payment.objects.filter(invoice_id__in=b2b_invoice_ids).aggregate(
            paid=Sum('amount')
        )['paid'] or Decimal('0')

        def type_summary(sale_type):
            row = by_type.get(sale_type)
            count = row['count'] if row else 0
            qty = row['qty'] if row else Decimal('0')
            value = row['value'] if row else Decimal('0')
            collected = b2b_collected if sale_type == SaleTypeMovement.SaleType.B2B_CREDIT else value
            return {
                'transaction_count': count,
                'total_quantity': str(qty),
                'transaction_value': str(value),
                'collected_value': str(collected),
            }

        by_sale_type = {sale_type: type_summary(sale_type) for sale_type in SALES_REPORT_TYPES}

        totals = {
            'transaction_count': sum(v['transaction_count'] for v in by_sale_type.values()),
            'total_quantity': str(
                sum((Decimal(v['total_quantity']) for v in by_sale_type.values()), Decimal('0'))
            ),
            'transaction_value': str(
                sum((Decimal(v['transaction_value']) for v in by_sale_type.values()), Decimal('0'))
            ),
            'collected_value': str(
                sum((Decimal(v['collected_value']) for v in by_sale_type.values()), Decimal('0'))
            ),
        }

        return Response({
            'date_from': date_from.isoformat() if date_from else None,
            'date_to': date_to.isoformat() if date_to else None,
            'totals': totals,
            'by_sale_type': by_sale_type,
        })


AGING_BUCKETS = ['current', '1-30', '31-60', '61-90', '90+']


class ReceivablesSummaryReportView(APIView):
    """GET: portfolio-wide receivables + aging, across all customers.

    date_from/date_to filter which invoices are included, by invoice_date.
    Aging buckets are always computed as of today (via Invoice.aging_bucket,
    which is due_date-based), regardless of the date filter — the filter
    narrows which invoices count, it does not change what "now" means for
    aging. Cancelled invoices are always excluded.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        date_from, date_to, error = _parse_date_range(request.query_params)
        if error:
            return error

        invoices = Invoice.objects.exclude(status=Invoice.Status.CANCELLED)
        if date_from:
            invoices = invoices.filter(invoice_date__gte=date_from)
        if date_to:
            invoices = invoices.filter(invoice_date__lte=date_to)

        invoice_list = list(invoices.select_related('customer'))

        total_invoiced = sum((inv.total for inv in invoice_list), Decimal('0'))
        total_collected = sum((inv.amount_paid for inv in invoice_list), Decimal('0'))
        total_outstanding = sum((inv.outstanding for inv in invoice_list), Decimal('0'))

        invoice_count = {'unpaid': 0, 'partially_paid': 0, 'paid': 0}
        aging = {bucket: {'invoice_count': 0, 'outstanding': Decimal('0')} for bucket in AGING_BUCKETS}
        customer_outstanding = {}

        for inv in invoice_list:
            if inv.status in invoice_count:
                invoice_count[inv.status] += 1

            bucket = inv.aging_bucket
            if bucket:
                aging[bucket]['invoice_count'] += 1
                aging[bucket]['outstanding'] += inv.outstanding

            if inv.outstanding > 0 and inv.customer_id:
                entry = customer_outstanding.setdefault(
                    inv.customer_id,
                    {
                        'customer_id': inv.customer_id,
                        'customer_name': inv.customer.name,
                        'outstanding': Decimal('0'),
                    },
                )
                entry['outstanding'] += inv.outstanding

        by_customer = sorted(
            customer_outstanding.values(), key=lambda e: e['outstanding'], reverse=True
        )

        return Response({
            'date_from': date_from.isoformat() if date_from else None,
            'date_to': date_to.isoformat() if date_to else None,
            'totals': {
                'total_invoiced': str(total_invoiced),
                'total_collected': str(total_collected),
                'total_outstanding': str(total_outstanding),
                'invoice_count': invoice_count,
            },
            'aging': {
                bucket: {'invoice_count': v['invoice_count'], 'outstanding': str(v['outstanding'])}
                for bucket, v in aging.items()
            },
            'by_customer': [
                {
                    'customer_id': e['customer_id'],
                    'customer_name': e['customer_name'],
                    'outstanding': str(e['outstanding']),
                }
                for e in by_customer
            ],
        })


DEFAULT_MOVEMENT_LIST_LIMIT = 50
MAX_MOVEMENT_LIST_LIMIT = 200


class MovementListView(APIView):
    """GET: unified, filterable history of every SaleTypeMovement — the
    backend feed for the future Sales History screen. Covers all 6 sale
    types (unlike the Invoice list, which only ever exists for b2b_credit).

    Query params: date_from, date_to (ISO date, filtered on created_at —
    the movement date, same semantics as the reporting endpoints),
    sale_type (comma-separated, e.g. 'b2c_cash,restock'), customer (customer_id
    exact match), limit/offset (pagination — see plan doc for why this
    endpoint paginates when the other plugin list endpoints don't).
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        params = request.query_params

        movements = SaleTypeMovement.objects.select_related(
            'part', 'customer', 'created_by', 'invoice_line__invoice'
        )

        date_from_raw = params.get('date_from')
        if date_from_raw:
            try:
                date_from = date.fromisoformat(date_from_raw)
            except ValueError:
                return Response({'detail': 'Invalid date_from'}, status=status.HTTP_400_BAD_REQUEST)
            movements = movements.filter(created_at__date__gte=date_from)

        date_to_raw = params.get('date_to')
        if date_to_raw:
            try:
                date_to = date.fromisoformat(date_to_raw)
            except ValueError:
                return Response({'detail': 'Invalid date_to'}, status=status.HTTP_400_BAD_REQUEST)
            movements = movements.filter(created_at__date__lte=date_to)

        sale_type_raw = params.get('sale_type')
        if sale_type_raw:
            requested_types = [v.strip() for v in sale_type_raw.split(',') if v.strip()]
            invalid_types = [v for v in requested_types if v not in SaleTypeMovement.SaleType.values]
            if invalid_types:
                return Response(
                    {'detail': f'Invalid sale_type: {", ".join(invalid_types)}'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            movements = movements.filter(sale_type__in=requested_types)

        customer_raw = params.get('customer')
        if customer_raw:
            try:
                customer_id = int(customer_raw)
            except ValueError:
                return Response({'detail': 'Invalid customer'}, status=status.HTTP_400_BAD_REQUEST)
            movements = movements.filter(customer_id=customer_id)

        try:
            limit = int(params.get('limit', DEFAULT_MOVEMENT_LIST_LIMIT))
        except ValueError:
            return Response({'detail': 'Invalid limit'}, status=status.HTTP_400_BAD_REQUEST)
        if limit <= 0 or limit > MAX_MOVEMENT_LIST_LIMIT:
            return Response(
                {'detail': f'limit must be between 1 and {MAX_MOVEMENT_LIST_LIMIT}'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            offset = int(params.get('offset', 0))
        except ValueError:
            return Response({'detail': 'Invalid offset'}, status=status.HTTP_400_BAD_REQUEST)
        if offset < 0:
            return Response({'detail': 'offset must not be negative'}, status=status.HTTP_400_BAD_REQUEST)

        count = movements.count()
        page = movements[offset:offset + limit]

        def invoice_fields(movement):
            line = getattr(movement, 'invoice_line', None)
            if not line:
                return None, None
            return line.invoice_id, line.invoice.reference

        results = []
        for movement in page:
            invoice_id, invoice_reference = invoice_fields(movement)
            results.append({
                'id': movement.id,
                'created_at': movement.created_at.isoformat(),
                'sale_type': movement.sale_type,
                'part_id': movement.part_id,
                'part_name': movement.part.name,
                'quantity': str(movement.quantity),
                'unit_value': str(movement.unit_value),
                'total_value': str(movement.total_value),
                'customer_id': movement.customer_id,
                'customer_name': movement.customer.name if movement.customer else None,
                'created_by_id': movement.created_by_id,
                'created_by_username': movement.created_by.username,
                'notes': movement.notes,
                'invoice_id': invoice_id,
                'invoice_reference': invoice_reference,
            })

        return Response({'count': count, 'results': results})


class MedicineInfoView(APIView):
    """GET medicine/ (all flagged medicines) or medicine/<part_id>/ (one part,
    defaults to over-the-counter). PUT/PATCH medicine/<part_id>/ sets
    requires_prescription and/or is_controlled.
    """

    permission_classes = [IsAuthenticated]

    @staticmethod
    def _serialize(part_id, info):
        def money(value):
            return None if value is None else str(value)

        return {
            'part_id': part_id,
            'requires_prescription': bool(info and info.requires_prescription),
            'is_controlled': bool(info and info.is_controlled),
            'generic_name': info.generic_name if info else '',
            'strength': info.strength if info else '',
            'dosage_form': info.dosage_form if info else '',
            'brand': info.brand if info else '',
            'manufacturer': info.manufacturer if info else '',
            'mrp': money(info.mrp) if info else None,
            'selling_price': money(info.selling_price) if info else None,
        }

    def get(self, request, part_id=None):
        if part_id is None:
            rows = MedicineInfo.objects.filter(
                Q(requires_prescription=True) | Q(is_controlled=True)
            )
            return Response([self._serialize(r.part_id, r) for r in rows])
        if not Part.objects.filter(pk=part_id).exists():
            return Response({'detail': 'Part not found'}, status=status.HTTP_404_NOT_FOUND)
        return Response(self._serialize(part_id, MedicineInfo.objects.filter(part_id=part_id).first()))

    def put(self, request, part_id=None):
        if part_id is None:
            return Response({'detail': 'part_id required'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            part = Part.objects.get(pk=part_id)
        except Part.DoesNotExist:
            return Response({'detail': 'Part not found'}, status=status.HTTP_404_NOT_FOUND)

        info, _ = MedicineInfo.objects.get_or_create(part=part)
        for field in ('requires_prescription', 'is_controlled'):
            if field in request.data:
                value = request.data[field]
                if not isinstance(value, bool):
                    return Response(
                        {'detail': f'{field} must be true or false'},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                setattr(info, field, value)
        # a controlled medicine is always prescription-only
        if info.is_controlled:
            info.requires_prescription = True
        info.save()
        return Response(self._serialize(part.pk, info))

    patch = put


DEFAULT_EXPIRY_WINDOW_DAYS = 90


class ExpiryReportView(APIView):
    """GET reports/expiry/?days=90: in-stock batches already expired, and
    batches expiring within `days` days (default 90), soonest first.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        try:
            days = int(request.query_params.get('days', DEFAULT_EXPIRY_WINDOW_DAYS))
        except ValueError:
            return Response({'detail': 'Invalid days'}, status=status.HTTP_400_BAD_REQUEST)
        if days < 0 or days > 3650:
            return Response(
                {'detail': 'days must be between 0 and 3650'}, status=status.HTTP_400_BAD_REQUEST
            )

        branch, error = _parse_branch({'branch_id': request.query_params.get('branch')})
        if error:
            return error

        today = timezone.localdate()
        batches = (
            StockItem.objects.filter(StockItem.IN_STOCK_FILTER, quantity__gt=0)
            .exclude(expiry_date=None)
            .filter(expiry_date__lte=today + timedelta(days=days))
            .select_related('part', 'location')
            .order_by('expiry_date', 'pk')
        )
        if branch is not None:
            batches = batches.filter(location__in=branch.get_descendants(include_self=True))

        def row(item):
            return {
                'stock_item_id': item.pk,
                'part_id': item.part_id,
                'part_name': item.part.name,
                'batch': item.batch,
                'expiry_date': item.expiry_date.isoformat(),
                'days_left': (item.expiry_date - today).days,
                'quantity': plain_quantity(item.quantity),
                'location': item.location.name if item.location else None,
            }

        expired = [row(i) for i in batches if i.expiry_date < today]
        expiring = [row(i) for i in batches if i.expiry_date >= today]
        return Response({
            'as_of': today.isoformat(),
            'window_days': days,
            'expired': expired,
            'expiring': expiring,
            'totals': {'expired_batches': len(expired), 'expiring_batches': len(expiring)},
        })


BILL_SALE_TYPES = {
    SaleTypeMovement.SaleType.B2C_CASH,
    SaleTypeMovement.SaleType.B2C_ONLINE,
    SaleTypeMovement.SaleType.PRESCRIPTION,
}


def _money(value):
    return str(Decimal(value).quantize(Decimal('0.01')))


def _bill_payload(bill):
    """Everything the printed bill needs: header, customer, lines, totals."""
    lines = []
    movements = bill.lines.select_related('part', 'tracking_entry__item').order_by('pk')
    for index, m in enumerate(movements, start=1):
        info = MedicineInfo.objects.filter(part=m.part).first()
        item = m.tracking_entry.item
        returned = sum((r.quantity for r in m.returns.all()), Decimal('0'))
        lines.append({
            'sn': index,
            'movement_id': m.pk,
            'returned_quantity': plain_quantity(returned),
            'part_id': m.part_id,
            'particulars': m.part.name,
            'brand': info.brand if info else '',
            'batch': item.batch if item else '',
            'expiry_date': item.expiry_date.isoformat() if item and item.expiry_date else None,
            'quantity': plain_quantity(m.quantity),
            'rate': _money(m.unit_value),
            'amount': _money(m.total_value),
        })

    return {
        'id': bill.pk,
        'reference': bill.reference,
        'created_at': bill.created_at.isoformat(),
        'sale_type': movements[0].sale_type if lines else None,
        'header': pharmacy_header(),
        'branch': bill.branch.name if bill.branch else '',
        'customer': {
            'name': bill.customer_name,
            'address': bill.customer_address,
            'phone': bill.customer_phone,
            'pan': bill.customer_pan,
        },
        'prescriber': bill.prescriber,
        'prescription_ref': bill.prescription_ref,
        'payment_mode': bill.payment_mode,
        'lines': lines,
        'subtotal': _money(bill.subtotal),
        'discount': _money(bill.discount),
        'discount_reason': bill.discount_reason,
        'net_amount': _money(bill.net_amount),
        'amount_in_words': amount_in_words(bill.net_amount),
        'remarks': bill.remarks,
        'dispensed_by': bill.created_by.get_full_name() or bill.created_by.get_username(),
    }


class RecordBillView(APIView):
    """POST: record one customer bill with several lines.

    Body: sale_type (b2c_cash | b2c_online | prescription), items (array of
    {part_id or stock_item_id, quantity, unit_value}), customer_name /
    customer_address / customer_phone / customer_pan (optional), prescriber,
    prescription_ref, payment_mode (cash | online | qr | other), discount
    (amount, needs discount_reason), remarks.

    Stock is taken earliest-expiry first for part_id lines. All-or-nothing.
    Returns the full bill (same shape as GET bills/<id>/).
    """

    permission_classes = [IsAuthenticated]

    def post(self, request):
        data = request.data

        sale_type = data.get('sale_type')
        if sale_type not in BILL_SALE_TYPES:
            return Response(
                {'detail': 'sale_type must be b2c_cash, b2c_online or prescription'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        items, error = _parse_line_items(data.get('items'))
        if error:
            return error

        branch, error = _parse_branch(data)
        if error:
            return error

        payment_mode = data.get('payment_mode', SaleBill.PaymentMode.CASH)
        if payment_mode not in SaleBill.PaymentMode.values:
            return Response({'detail': 'Invalid payment_mode'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            discount = Decimal(str(data.get('discount') or 0)).quantize(Decimal('0.01'))
        except InvalidOperation:
            return Response({'detail': 'Invalid discount'}, status=status.HTTP_400_BAD_REQUEST)
        if discount < 0:
            return Response(
                {'detail': 'discount must not be negative'}, status=status.HTTP_400_BAD_REQUEST
            )
        discount_reason = (data.get('discount_reason') or '').strip()
        if discount > 0 and not discount_reason:
            return Response(
                {'detail': 'discount_reason is required when a discount is given'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        def text(key):
            return (data.get(key) or '').strip()

        prescriber = text('prescriber')
        prescription_ref = text('prescription_ref')
        remarks = text('remarks')

        try:
            with transaction.atomic():
                for item in items:
                    check_prescription_rules(
                        item['part'] or item['stock_item'].part,
                        sale_type, prescriber, prescription_ref,
                    )

                bill = SaleBill.objects.create(
                    customer_name=text('customer_name'),
                    customer_address=text('customer_address'),
                    customer_phone=text('customer_phone'),
                    customer_pan=text('customer_pan'),
                    prescriber=prescriber,
                    prescription_ref=prescription_ref,
                    payment_mode=payment_mode,
                    discount=discount,
                    discount_reason=discount_reason,
                    remarks=remarks,
                    branch=branch,
                    created_by=request.user,
                )

                movements = [
                    record_sale_movement(
                        stock_item=batch,
                        sale_type=sale_type,
                        quantity=qty,
                        unit_value=item['unit_value'],
                        customer=None,
                        user=request.user,
                        notes=remarks,
                        prescriber=prescriber,
                        prescription_ref=prescription_ref,
                        bill=bill,
                    )
                    for item in items
                    for batch, qty in resolve_allocations(
                        stock_item=item['stock_item'],
                        part=item['part'],
                        quantity=item['quantity'],
                        branch=branch,
                    )
                ]

                subtotal = sum((m.total_value for m in movements), Decimal('0'))
                if discount > subtotal:
                    raise SaleValidationError('discount cannot be more than the bill total')
                bill.subtotal = subtotal
                bill.net_amount = subtotal - discount
                bill.save(update_fields=['subtotal', 'net_amount'])
        except SaleValidationError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except SaleRecordingError:
            return Response({'detail': 'Stock update failed'}, status=status.HTTP_400_BAD_REQUEST)

        return Response(_bill_payload(bill), status=status.HTTP_201_CREATED)


class BillDetailView(APIView):
    """GET bills/<id>/: one bill with pharmacy header, lines (batch, expiry),
    totals and the net amount in words."""

    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        try:
            bill = SaleBill.objects.select_related('created_by').get(pk=pk)
        except SaleBill.DoesNotExist:
            return Response({'detail': 'Bill not found'}, status=status.HTTP_404_NOT_FOUND)
        return Response(_bill_payload(bill))


class BillListView(APIView):
    """GET bills/?limit=20&search=: recent bills, newest first."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        try:
            limit = int(request.query_params.get('limit', 20))
        except ValueError:
            return Response({'detail': 'Invalid limit'}, status=status.HTTP_400_BAD_REQUEST)
        if limit <= 0 or limit > 200:
            return Response(
                {'detail': 'limit must be between 1 and 200'}, status=status.HTTP_400_BAD_REQUEST
            )

        bills = SaleBill.objects.all()
        search = (request.query_params.get('search') or '').strip()
        if search:
            bills = bills.filter(
                Q(reference__icontains=search)
                | Q(customer_name__icontains=search)
                | Q(customer_phone__icontains=search)
            )

        return Response({
            'count': bills.count(),
            'results': [
                {
                    'id': b.pk,
                    'reference': b.reference,
                    'customer_name': b.customer_name,
                    'payment_mode': b.payment_mode,
                    'net_amount': _money(b.net_amount),
                    'created_at': b.created_at.isoformat(),
                }
                for b in bills[:limit]
            ],
        })


class BranchListView(APIView):
    """GET branches/: the pharmacy's branches (top-level stock locations)."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        branches = StockLocation.objects.filter(parent=None).order_by('name')
        return Response([{'id': b.pk, 'name': b.name} for b in branches])


def _money_in(data, key, default='0'):
    """Non-negative money amount from request data, or raise ValueError."""
    try:
        value = Decimal(str(data.get(key) if data.get(key) not in (None, '') else default))
    except InvalidOperation as exc:
        raise ValueError(f'Invalid {key}') from exc
    if value < 0:
        raise ValueError(f'{key} must not be negative')
    return value.quantize(Decimal('0.01'))


class ReceiveStockView(APIView):
    """POST: receive a purchase line into stock as a new batch.

    Body: part_id, batch, expiry_date (ISO, must be in the future),
    quantity, bonus_quantity (free stock, optional), unit_cost, discount,
    tax, payment_status (unpaid | partial | paid), location_id (required),
    supplier_id (optional), invoice_no, purchase_date (default today),
    notes. Creates the StockItem (quantity + bonus) and a PurchaseReceipt
    atomically. line_total = quantity x unit_cost - discount + tax.
    """

    permission_classes = [IsAuthenticated]

    def post(self, request):
        data = request.data

        try:
            part = Part.objects.get(pk=data.get('part_id'))
        except (Part.DoesNotExist, ValueError, TypeError):
            return Response({'detail': 'part_id must reference an existing part'}, status=400)

        batch = (data.get('batch') or '').strip()
        if not batch:
            return Response({'detail': 'batch is required'}, status=400)

        try:
            expiry = date.fromisoformat(str(data.get('expiry_date') or ''))
        except ValueError:
            return Response({'detail': 'expiry_date is required (YYYY-MM-DD)'}, status=400)
        if expiry < timezone.localdate():
            return Response({'detail': 'expiry_date is already in the past'}, status=400)

        try:
            quantity = Decimal(str(data.get('quantity')))
            if quantity <= 0:
                raise InvalidOperation
        except (InvalidOperation, TypeError):
            return Response({'detail': 'quantity must be a positive number'}, status=400)

        try:
            bonus = Decimal(str(data.get('bonus_quantity') or 0))
            if bonus < 0:
                raise InvalidOperation
            unit_cost = _money_in(data, 'unit_cost')
            discount = _money_in(data, 'discount')
            tax = _money_in(data, 'tax')
        except InvalidOperation:
            return Response({'detail': 'bonus_quantity must not be negative'}, status=400)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=400)

        payment_status = data.get('payment_status', PurchaseReceipt.PaymentStatus.UNPAID)
        if payment_status not in PurchaseReceipt.PaymentStatus.values:
            return Response({'detail': 'Invalid payment_status'}, status=400)

        try:
            location = StockLocation.objects.get(pk=data.get('location_id'))
        except (StockLocation.DoesNotExist, ValueError, TypeError):
            return Response({'detail': 'location_id is required (the branch / shelf)'}, status=400)

        supplier = None
        if data.get('supplier_id') not in (None, ''):
            try:
                supplier = Company.objects.get(pk=data.get('supplier_id'), is_supplier=True)
            except (Company.DoesNotExist, ValueError, TypeError):
                return Response({'detail': 'supplier_id must be an existing supplier'}, status=400)

        try:
            purchase_date = date.fromisoformat(str(data.get('purchase_date') or timezone.localdate()))
        except ValueError:
            return Response({'detail': 'Invalid purchase_date'}, status=400)

        gross = quantity * unit_cost
        if discount > gross:
            return Response({'detail': 'discount cannot be more than the purchase value'}, status=400)
        line_total = (gross - discount + tax).quantize(Decimal('0.01'))
        total_units = quantity + bonus
        effective_cost = (line_total / total_units).quantize(Decimal('0.00001'))

        with transaction.atomic():
            item = StockItem.objects.create(
                part=part,
                quantity=total_units,
                batch=batch,
                expiry_date=expiry,
                location=location,
                purchase_price=effective_cost,
                supplier_part=None,
                delete_on_deplete=False,
            )
            receipt = PurchaseReceipt.objects.create(
                part=part,
                stock_item=item,
                supplier=supplier,
                invoice_no=(data.get('invoice_no') or '').strip(),
                purchase_date=purchase_date,
                batch=batch,
                expiry_date=expiry,
                quantity=quantity,
                bonus_quantity=bonus,
                unit_cost=unit_cost,
                discount=discount,
                tax=tax,
                line_total=line_total,
                payment_status=payment_status,
                notes=(data.get('notes') or '').strip(),
                received_by=request.user,
            )

        return Response(_receipt_payload(receipt), status=status.HTTP_201_CREATED)


def _receipt_payload(r):
    return {
        'id': r.pk,
        'part_id': r.part_id,
        'part_name': r.part.name,
        'stock_item_id': r.stock_item_id,
        'supplier': r.supplier.name if r.supplier else '',
        'invoice_no': r.invoice_no,
        'purchase_date': r.purchase_date.isoformat(),
        'batch': r.batch,
        'expiry_date': r.expiry_date.isoformat(),
        'quantity': plain_quantity(r.quantity),
        'bonus_quantity': plain_quantity(r.bonus_quantity),
        'unit_cost': _money(r.unit_cost),
        'discount': _money(r.discount),
        'tax': _money(r.tax),
        'line_total': _money(r.line_total),
        'payment_status': r.payment_status,
        'received_by': r.received_by.get_full_name() or r.received_by.get_username(),
    }


class PurchaseListView(APIView):
    """GET purchases/?limit=50&search=&payment_status=: recent purchase lines."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        try:
            limit = int(request.query_params.get('limit', 50))
        except ValueError:
            return Response({'detail': 'Invalid limit'}, status=400)
        if limit <= 0 or limit > 200:
            return Response({'detail': 'limit must be between 1 and 200'}, status=400)

        rows = PurchaseReceipt.objects.select_related('part', 'supplier', 'received_by')
        status_filter = request.query_params.get('payment_status')
        if status_filter:
            if status_filter not in PurchaseReceipt.PaymentStatus.values:
                return Response({'detail': 'Invalid payment_status'}, status=400)
            rows = rows.filter(payment_status=status_filter)
        search = (request.query_params.get('search') or '').strip()
        if search:
            rows = rows.filter(
                Q(invoice_no__icontains=search)
                | Q(batch__icontains=search)
                | Q(part__name__icontains=search)
                | Q(supplier__name__icontains=search)
            )
        return Response({
            'count': rows.count(),
            'results': [_receipt_payload(r) for r in rows[:limit]],
        })


class AdjustStockView(APIView):
    """POST adjust-stock/: signed manual change to one batch.

    Body: stock_item_id, quantity_change (positive adds, negative removes,
    not zero), reason (required), approved_by (required), reference_no,
    remarks. A removal cannot exceed what the batch holds.
    """

    permission_classes = [IsAuthenticated]

    def post(self, request):
        data = request.data
        try:
            item = StockItem.objects.select_related('part').get(pk=data.get('stock_item_id'))
        except (StockItem.DoesNotExist, ValueError, TypeError):
            return Response({'detail': 'stock_item_id must reference an existing batch'}, status=400)

        try:
            change = Decimal(str(data.get('quantity_change')))
        except InvalidOperation:
            return Response({'detail': 'quantity_change must be a number'}, status=400)
        if change == 0:
            return Response({'detail': 'quantity_change must not be zero'}, status=400)

        reason = (data.get('reason') or '').strip()
        approved_by = (data.get('approved_by') or '').strip()
        if not reason:
            return Response({'detail': 'reason is required'}, status=400)
        if not approved_by:
            return Response({'detail': 'approved_by is required'}, status=400)
        if change < 0 and -change > item.quantity:
            return Response(
                {'detail': f'Cannot remove {-change}: the batch holds {plain_quantity(item.quantity)}'},
                status=400,
            )

        note = f'Adjustment: {reason} (approved by {approved_by})'
        with transaction.atomic():
            if item.delete_on_deplete:
                item.delete_on_deplete = False
                item.save(update_fields=['delete_on_deplete'])
            ok = (
                item.add_stock(change, request.user, notes=note)
                if change > 0
                else item.take_stock(-change, request.user, notes=note)
            )
            if not ok:
                return Response({'detail': 'Stock update failed'}, status=400)
            adjustment = StockAdjustment.objects.create(
                part=item.part,
                stock_item=item,
                batch=item.batch or '',
                quantity_change=change,
                reason=reason,
                approved_by=approved_by,
                reference_no=(data.get('reference_no') or '').strip(),
                remarks=(data.get('remarks') or '').strip(),
                created_by=request.user,
            )
        item.refresh_from_db()
        return Response(
            {
                'id': adjustment.pk,
                'part_name': item.part.name,
                'batch': item.batch,
                'quantity_change': plain_quantity(change),
                'new_quantity': plain_quantity(item.quantity),
            },
            status=status.HTTP_201_CREATED,
        )


class AdjustmentListView(APIView):
    """GET adjustments/?limit=50: recent stock adjustments."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        rows = StockAdjustment.objects.select_related('part', 'created_by')[:100]
        return Response({
            'results': [
                {
                    'id': a.pk,
                    'date': a.created_at.isoformat(),
                    'part_name': a.part.name,
                    'batch': a.batch,
                    'quantity_change': plain_quantity(a.quantity_change),
                    'reason': a.reason,
                    'approved_by': a.approved_by,
                    'reference_no': a.reference_no,
                    'by': a.created_by.get_username(),
                }
                for a in rows
            ]
        })


class SalesReturnView(APIView):
    """POST sales-return/: return part of one bill line.

    Body: movement_id (a line of a bill: see bills/<id>/), quantity,
    reason (required), disposition (resalable | not_resalable),
    unit_refund_rate (optional, default the sold rate, never above it),
    remarks. Resalable stock goes back into the original batch.
    """

    permission_classes = [IsAuthenticated]

    def post(self, request):
        data = request.data
        try:
            movement = SaleTypeMovement.objects.select_related(
                'bill', 'part', 'tracking_entry__item'
            ).get(pk=data.get('movement_id'), bill__isnull=False)
        except (SaleTypeMovement.DoesNotExist, ValueError, TypeError):
            return Response({'detail': 'movement_id must be a line of a bill'}, status=400)

        try:
            quantity = Decimal(str(data.get('quantity')))
            if quantity <= 0:
                raise InvalidOperation
        except (InvalidOperation, TypeError):
            return Response({'detail': 'quantity must be a positive number'}, status=400)

        returned = sum((r.quantity for r in movement.returns.all()), Decimal('0'))
        remaining = movement.quantity - returned
        if quantity > remaining:
            return Response(
                {'detail': f'Only {plain_quantity(remaining)} of this line can still be returned'},
                status=400,
            )

        reason = (data.get('reason') or '').strip()
        if not reason:
            return Response({'detail': 'reason is required'}, status=400)
        disposition = data.get('disposition')
        if disposition not in SalesReturn.Disposition.values:
            return Response({'detail': 'disposition must be resalable or not_resalable'}, status=400)

        try:
            rate = Decimal(str(data.get('unit_refund_rate') or movement.unit_value)).quantize(
                Decimal('0.01')
            )
        except InvalidOperation:
            return Response({'detail': 'Invalid unit_refund_rate'}, status=400)
        if rate < 0 or rate > movement.unit_value:
            return Response({'detail': 'unit_refund_rate cannot be more than the sold rate'}, status=400)

        item = movement.tracking_entry.item
        if disposition == SalesReturn.Disposition.RESALABLE and item is None:
            return Response({'detail': 'The original batch no longer exists'}, status=400)

        with transaction.atomic():
            if disposition == SalesReturn.Disposition.RESALABLE:
                record_sale_movement(
                    stock_item=item,
                    sale_type=SaleTypeMovement.SaleType.RETURN,
                    quantity=quantity,
                    unit_value=rate,
                    customer=None,
                    user=request.user,
                    notes=f'Return against {movement.bill.reference}: {reason}',
                )
            sales_return = SalesReturn.objects.create(
                bill=movement.bill,
                movement=movement,
                part=movement.part,
                batch=item.batch if item else '',
                quantity=quantity,
                unit_refund_rate=rate,
                refund_amount=(quantity * rate).quantize(Decimal('0.01')),
                reason=reason,
                disposition=disposition,
                remarks=(data.get('remarks') or '').strip(),
                processed_by=request.user,
            )

        return Response(
            {
                'id': sales_return.pk,
                'reference': sales_return.reference,
                'bill': movement.bill.reference,
                'part_name': movement.part.name,
                'batch': sales_return.batch,
                'quantity': plain_quantity(quantity),
                'refund_amount': _money(sales_return.refund_amount),
                'disposition': disposition,
            },
            status=status.HTTP_201_CREATED,
        )


class SalesReturnListView(APIView):
    """GET sales-returns/: recent customer returns."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        rows = SalesReturn.objects.select_related('bill', 'part', 'processed_by')[:100]
        return Response({
            'results': [
                {
                    'id': r.pk,
                    'reference': r.reference,
                    'bill': r.bill.reference,
                    'date': r.created_at.isoformat(),
                    'part_name': r.part.name,
                    'batch': r.batch,
                    'quantity': plain_quantity(r.quantity),
                    'refund_amount': _money(r.refund_amount),
                    'reason': r.reason,
                    'disposition': r.disposition,
                    'processed_by': r.processed_by.get_username(),
                }
                for r in rows
            ]
        })

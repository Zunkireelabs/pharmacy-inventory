"""API endpoints for recording sale-type-tagged stock movements and
managing B2B receivables (invoices/payments).
"""

from datetime import date, timedelta
from decimal import Decimal, InvalidOperation

from django.db import transaction
from django.db.models import Count, Sum
from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from company.models import Company
from stock.models import StockItem

from .models import Invoice, InvoiceLineItem, Payment, SaleTypeMovement
from .services import OUTBOUND_TYPES, SaleRecordingError, record_sale_movement


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
    """POST body: stock_item_id, sale_type, quantity, unit_value (optional,
    default 0), customer_id (required for b2b_credit), notes (optional).
    """

    permission_classes = [IsAuthenticated]

    def post(self, request):
        data = request.data

        try:
            stock_item = StockItem.objects.get(pk=data.get('stock_item_id'))
        except (StockItem.DoesNotExist, ValueError, TypeError):
            return Response(
                {'detail': 'stock_item_id is required and must reference an existing stock item'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        sale_type = data.get('sale_type')
        if sale_type not in SaleTypeMovement.SaleType.values:
            return Response({'detail': 'Invalid sale_type'}, status=status.HTTP_400_BAD_REQUEST)

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

        if sale_type == SaleTypeMovement.SaleType.GIFT and unit_value <= 0:
            return Response(
                {'detail': 'unit_value is required and must be greater than zero for gift movements'},
                status=status.HTTP_400_BAD_REQUEST,
            )

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

        if sale_type in OUTBOUND_TYPES and stock_item.quantity < quantity:
            return Response(
                {'detail': 'Insufficient stock for this movement'}, status=status.HTTP_400_BAD_REQUEST
            )

        try:
            with transaction.atomic():
                movement = record_sale_movement(
                    stock_item=stock_item,
                    sale_type=sale_type,
                    quantity=quantity,
                    unit_value=unit_value,
                    customer=customer,
                    user=request.user,
                    notes=data.get('notes', ''),
                )
        except SaleRecordingError:
            return Response({'detail': 'Stock update failed'}, status=status.HTTP_400_BAD_REQUEST)

        return Response({'id': movement.id}, status=status.HTTP_201_CREATED)


DEFAULT_DUE_DAYS = 30


def _parse_line_items(raw_items):
    """Validate and parse the `items` array shared by RecordB2BSaleView.

    Returns (parsed_items, error_response). parsed_items is a list of dicts
    with keys stock_item (StockItem instance), quantity (Decimal),
    unit_value (Decimal). error_response is None on success.
    """
    if not isinstance(raw_items, list) or not raw_items:
        return None, Response(
            {'detail': 'items must be a non-empty array'}, status=status.HTTP_400_BAD_REQUEST
        )

    parsed = []
    for raw in raw_items:
        try:
            stock_item = StockItem.objects.get(pk=raw.get('stock_item_id'))
        except (StockItem.DoesNotExist, ValueError, TypeError, AttributeError):
            return None, Response(
                {'detail': 'Each item requires a valid stock_item_id'},
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

        if stock_item.quantity < quantity:
            return None, Response(
                {'detail': f'Insufficient stock for {stock_item.part.name}'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        parsed.append({
            'stock_item': stock_item,
            'quantity': quantity,
            'unit_value': unit_value,
        })

    return parsed, None


class RecordB2BSaleView(APIView):
    """POST body: items (required, non-empty array of {stock_item_id,
    quantity, unit_value}), customer_id (required, must be an
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
                        stock_item=item['stock_item'],
                        sale_type=SaleTypeMovement.SaleType.B2B_CREDIT,
                        quantity=item['quantity'],
                        unit_value=item['unit_value'],
                        customer=customer,
                        user=request.user,
                        notes=notes,
                    )
                    for item in items
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
]


class SalesSummaryReportView(APIView):
    """GET: aggregate sales totals (b2b_credit/b2c_cash/b2c_online only —
    gift/restock/correction are never sales) over an optional date range.

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


class GiftSummaryReportView(APIView):
    """GET: gift movement totals + per-part breakdown over an optional date
    range, filtered on SaleTypeMovement.created_at. Valuation always comes
    from the immutable unit_value/total_value snapshot on each movement —
    never from current Part/StockItem pricing.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        date_from, date_to, error = _parse_date_range(request.query_params)
        if error:
            return error

        movements = SaleTypeMovement.objects.filter(sale_type=SaleTypeMovement.SaleType.GIFT)
        if date_from:
            movements = movements.filter(created_at__date__gte=date_from)
        if date_to:
            movements = movements.filter(created_at__date__lte=date_to)

        totals = movements.aggregate(count=Count('id'), qty=Sum('quantity'), value=Sum('total_value'))

        by_part_rows = movements.values('part_id', 'part__name').annotate(
            qty=Sum('quantity'), value=Sum('total_value')
        ).order_by('-value')

        return Response({
            'date_from': date_from.isoformat() if date_from else None,
            'date_to': date_to.isoformat() if date_to else None,
            'totals': {
                'gift_count': totals['count'] or 0,
                'total_quantity': str(totals['qty'] or Decimal('0')),
                'total_value': str(totals['value'] or Decimal('0')),
            },
            'by_part': [
                {
                    'part_id': row['part_id'],
                    'part_name': row['part__name'],
                    'quantity': str(row['qty']),
                    'value': str(row['value']),
                }
                for row in by_part_rows
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
    sale_type (comma-separated, e.g. 'gift,restock'), customer (customer_id
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

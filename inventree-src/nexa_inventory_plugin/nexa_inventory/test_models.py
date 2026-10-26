from datetime import timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.test import TestCase
from django.utils import timezone

from company.models import Company
from part.models import Part
from stock.models import StockItem, StockItemTracking
from stock.status_codes import StockHistoryCode

from .models import Invoice, InvoiceLineItem, Payment, SaleTypeMovement

User = get_user_model()


class SaleTypeMovementTest(TestCase):
    def setUp(self):
        self.user = User.objects.create_user('tester', password='pw')
        self.part = Part.objects.create(name='Test Pen', description='Test', active=True)
        self.stock_item = StockItem.objects.create(part=self.part, quantity=10)
        self.tracking = StockItemTracking.objects.create(
            item=self.stock_item, tracking_type=StockHistoryCode.STOCK_REMOVE
        )

    def test_create_gift_movement(self):
        movement = SaleTypeMovement.objects.create(
            tracking_entry=self.tracking,
            part=self.part,
            sale_type=SaleTypeMovement.SaleType.GIFT,
            quantity=Decimal('2'),
            unit_value=Decimal('50.00'),
            total_value=Decimal('100.00'),
            notes='test gift',
            created_by=self.user,
        )
        self.assertEqual(movement.sale_type, 'gift')
        self.assertIsNone(movement.customer)

    def test_create_b2b_credit_movement_requires_customer_at_app_layer(self):
        customer = Company.objects.create(name='Test Customer', is_customer=True)
        movement = SaleTypeMovement.objects.create(
            tracking_entry=StockItemTracking.objects.create(
                item=self.stock_item, tracking_type=StockHistoryCode.STOCK_REMOVE
            ),
            part=self.part,
            sale_type=SaleTypeMovement.SaleType.B2B_CREDIT,
            quantity=Decimal('1'),
            unit_value=Decimal('50.00'),
            total_value=Decimal('50.00'),
            customer=customer,
            created_by=self.user,
        )
        self.assertEqual(movement.customer, customer)


class InvoiceTest(TestCase):
    def setUp(self):
        self.user = User.objects.create_user('invoice-tester', password='pw')
        self.customer = Company.objects.create(name='Acme Pharma', is_customer=True)

    def test_reference_auto_generates_with_default_pattern(self):
        invoice = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate() + timedelta(days=30),
            total=Decimal('500.00'),
            created_by=self.user,
        )
        self.assertTrue(invoice.reference.startswith('INV-'))
        self.assertEqual(invoice.status, Invoice.Status.UNPAID)

    def test_second_invoice_reference_increments(self):
        first = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate(),
            total=Decimal('100'),
            created_by=self.user,
        )
        second = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate(),
            total=Decimal('100'),
            created_by=self.user,
        )
        self.assertNotEqual(first.reference, second.reference)

    def test_outstanding_equals_total_with_no_payments(self):
        invoice = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate(),
            total=Decimal('250.00'),
            created_by=self.user,
        )
        self.assertEqual(invoice.outstanding, Decimal('250.00'))
        self.assertEqual(invoice.amount_paid, Decimal('0'))

    def test_aging_bucket_current_when_not_yet_due(self):
        invoice = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate() + timedelta(days=10),
            total=Decimal('100'),
            created_by=self.user,
        )
        self.assertEqual(invoice.aging_bucket, 'current')

    def test_aging_bucket_31_60_days_overdue(self):
        invoice = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate() - timedelta(days=45),
            total=Decimal('100'),
            created_by=self.user,
        )
        self.assertEqual(invoice.aging_bucket, '31-60')


class InvoiceLineItemTest(TestCase):
    def setUp(self):
        self.user = User.objects.create_user('line-tester', password='pw')
        self.customer = Company.objects.create(name='Acme Pharma', is_customer=True)
        self.part = Part.objects.create(name='Test Pad', description='Test', active=True)
        self.stock_item = StockItem.objects.create(part=self.part, quantity=10)

    def _make_movement(self, sale_type=SaleTypeMovement.SaleType.B2B_CREDIT):
        tracking = StockItemTracking.objects.create(
            item=self.stock_item, tracking_type=StockHistoryCode.SENT_TO_CUSTOMER
        )
        return SaleTypeMovement.objects.create(
            tracking_entry=tracking,
            part=self.part,
            sale_type=sale_type,
            quantity=Decimal('3'),
            unit_value=Decimal('20.00'),
            total_value=Decimal('60.00'),
            customer=self.customer if sale_type == SaleTypeMovement.SaleType.B2B_CREDIT else None,
            created_by=self.user,
        )

    def test_line_item_proxies_movement_values(self):
        movement = self._make_movement()
        invoice = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate(),
            total=movement.total_value,
            created_by=self.user,
        )
        line = InvoiceLineItem.objects.create(invoice=invoice, sale_type_movement=movement)
        self.assertEqual(line.quantity, Decimal('3'))
        self.assertEqual(line.unit_price, Decimal('20.00'))
        self.assertEqual(line.line_total, Decimal('60.00'))

    def test_non_b2b_movement_rejected_by_clean(self):
        movement = self._make_movement(sale_type=SaleTypeMovement.SaleType.GIFT)
        invoice = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate(),
            total=Decimal('60.00'),
            created_by=self.user,
        )
        line = InvoiceLineItem(invoice=invoice, sale_type_movement=movement)
        with self.assertRaises(ValidationError):
            line.full_clean()


class PaymentTest(TestCase):
    def setUp(self):
        self.user = User.objects.create_user('pay-tester', password='pw')
        self.customer = Company.objects.create(name='Acme Pharma', is_customer=True)
        self.invoice = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate(),
            total=Decimal('50000'),
            created_by=self.user,
        )

    def test_multiple_partial_payments_reach_paid(self):
        Payment.objects.create(
            invoice=self.invoice, amount=Decimal('10000'), method=Payment.Method.CASH,
            recorded_by=self.user,
        )
        self.invoice.refresh_status()
        self.assertEqual(self.invoice.status, Invoice.Status.PARTIALLY_PAID)
        self.assertEqual(self.invoice.outstanding, Decimal('40000'))

        Payment.objects.create(
            invoice=self.invoice, amount=Decimal('15000'), method=Payment.Method.ONLINE,
            recorded_by=self.user,
        )
        self.invoice.refresh_status()
        self.assertEqual(self.invoice.outstanding, Decimal('25000'))
        self.assertEqual(self.invoice.status, Invoice.Status.PARTIALLY_PAID)

        Payment.objects.create(
            invoice=self.invoice, amount=Decimal('25000'), method=Payment.Method.CHEQUE,
            recorded_by=self.user,
        )
        self.invoice.refresh_status()
        self.assertEqual(self.invoice.outstanding, Decimal('0'))
        self.assertEqual(self.invoice.status, Invoice.Status.PAID)

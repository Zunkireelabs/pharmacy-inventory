from datetime import timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase

from company.models import Company
from InvenTree.unit_test import PluginRegistryMixin
from part.models import Part
from stock.models import StockItem

from .models import Invoice, Payment, SaleTypeMovement

User = get_user_model()


@override_settings(USE_TZ=True)
class RecordSaleApiTest(PluginRegistryMixin, APITestCase):
    def setUp(self):
        self.user = User.objects.create_user('tester', password='pw', is_staff=True)
        self.client.force_login(self.user)
        cache.clear()  # reset DRF throttle counters shared across the suite
        self.part = Part.objects.create(
            name='Test Pen', description='Test', active=True, purchaseable=True, salable=True
        )
        self.stock_item = StockItem.objects.create(part=self.part, quantity=10)
        self.url = reverse('plugin:nexainventory:record-sale')

    def test_record_b2c_cash_reduces_stock_and_creates_movement(self):
        response = self.client.post(
            self.url,
            {
                'stock_item_id': self.stock_item.pk,
                'sale_type': 'b2c_cash',
                'quantity': '2',
                'unit_value': '50.00',
                'notes': 'test sale',
            },
            format='json',
        )
        self.assertEqual(response.status_code, 201, response.content)
        self.stock_item.refresh_from_db()
        self.assertEqual(self.stock_item.quantity, 8)
        movement = SaleTypeMovement.objects.get(id=response.data['id'])
        self.assertEqual(movement.sale_type, 'b2c_cash')
        self.assertEqual(movement.total_value, Decimal('100.00'))

    def test_b2c_cash_still_allows_zero_value(self):
        response = self.client.post(
            self.url,
            {
                'stock_item_id': self.stock_item.pk,
                'sale_type': 'b2c_cash',
                'quantity': '1',
            },
            format='json',
        )
        self.assertEqual(response.status_code, 201, response.content)

    def test_b2b_credit_requires_customer(self):
        response = self.client.post(
            self.url,
            {
                'stock_item_id': self.stock_item.pk,
                'sale_type': 'b2b_credit',
                'quantity': '1',
                'unit_value': '50.00',
            },
            format='json',
        )
        self.assertEqual(response.status_code, 400)
        self.stock_item.refresh_from_db()
        self.assertEqual(self.stock_item.quantity, 10)

    def test_restock_increases_stock(self):
        response = self.client.post(
            self.url,
            {
                'stock_item_id': self.stock_item.pk,
                'sale_type': 'restock',
                'quantity': '5',
                'unit_value': '30.00',
            },
            format='json',
        )
        self.assertEqual(response.status_code, 201, response.content)
        self.stock_item.refresh_from_db()
        self.assertEqual(self.stock_item.quantity, 15)

    def test_insufficient_stock_rejected(self):
        response = self.client.post(
            self.url,
            {
                'stock_item_id': self.stock_item.pk,
                'sale_type': 'b2c_cash',
                'quantity': '999',
                'unit_value': '50.00',
            },
            format='json',
        )
        self.assertEqual(response.status_code, 400)


@override_settings(USE_TZ=True)
class RecordB2BSaleApiTest(PluginRegistryMixin, APITestCase):
    def setUp(self):
        self.user = User.objects.create_user('b2b-tester', password='pw', is_staff=True)
        self.client.force_login(self.user)
        cache.clear()  # reset DRF throttle counters shared across the suite
        self.part = Part.objects.create(
            name='Test Notebook', description='Test', active=True, purchaseable=True, salable=True
        )
        self.stock_item = StockItem.objects.create(part=self.part, quantity=50)
        self.customer = Company.objects.create(name='Acme Pharma', is_customer=True)
        self.url = reverse('plugin:nexainventory:record-b2b-sale')

    def test_valid_b2b_sale_creates_invoice_and_reduces_stock(self):
        response = self.client.post(
            self.url,
            {
                'items': [
                    {'stock_item_id': self.stock_item.pk, 'quantity': '5', 'unit_value': '100.00'},
                ],
                'customer_id': self.customer.pk,
            },
            format='json',
        )
        self.assertEqual(response.status_code, 201, response.content)
        self.stock_item.refresh_from_db()
        self.assertEqual(self.stock_item.quantity, 45)

        invoice = Invoice.objects.get(id=response.data['invoice_id'])
        self.assertEqual(invoice.customer, self.customer)
        self.assertEqual(invoice.total, Decimal('500.00'))
        self.assertEqual(invoice.outstanding, Decimal('500.00'))
        self.assertEqual(invoice.status, Invoice.Status.UNPAID)
        self.assertEqual(invoice.lines.count(), 1)
        line = invoice.lines.first()
        self.assertEqual(line.sale_type_movement.sale_type, 'b2b_credit')
        self.assertEqual(line.quantity, Decimal('5'))

    def test_multi_line_b2b_sale_creates_one_invoice_with_multiple_lines(self):
        second_part = Part.objects.create(
            name='Test Pen', description='Test', active=True, purchaseable=True, salable=True
        )
        second_stock_item = StockItem.objects.create(part=second_part, quantity=20)

        response = self.client.post(
            self.url,
            {
                'items': [
                    {'stock_item_id': self.stock_item.pk, 'quantity': '5', 'unit_value': '100.00'},
                    {'stock_item_id': second_stock_item.pk, 'quantity': '2', 'unit_value': '50.00'},
                ],
                'customer_id': self.customer.pk,
            },
            format='json',
        )
        self.assertEqual(response.status_code, 201, response.content)

        self.stock_item.refresh_from_db()
        second_stock_item.refresh_from_db()
        self.assertEqual(self.stock_item.quantity, 45)
        self.assertEqual(second_stock_item.quantity, 18)

        invoice = Invoice.objects.get(id=response.data['invoice_id'])
        self.assertEqual(invoice.total, Decimal('600.00'))
        self.assertEqual(invoice.lines.count(), 2)

    def test_insufficient_stock_on_one_line_rolls_back_whole_sale(self):
        second_part = Part.objects.create(
            name='Test Pen', description='Test', active=True, purchaseable=True, salable=True
        )
        second_stock_item = StockItem.objects.create(part=second_part, quantity=20)

        response = self.client.post(
            self.url,
            {
                'items': [
                    {'stock_item_id': self.stock_item.pk, 'quantity': '5', 'unit_value': '100.00'},
                    {'stock_item_id': second_stock_item.pk, 'quantity': '999', 'unit_value': '50.00'},
                ],
                'customer_id': self.customer.pk,
            },
            format='json',
        )
        self.assertEqual(response.status_code, 400)
        self.stock_item.refresh_from_db()
        self.assertEqual(self.stock_item.quantity, 50)
        self.assertEqual(Invoice.objects.count(), 0)

    def test_empty_items_rejected(self):
        response = self.client.post(
            self.url,
            {'items': [], 'customer_id': self.customer.pk},
            format='json',
        )
        self.assertEqual(response.status_code, 400)

    def test_invalid_customer_rejected(self):
        response = self.client.post(
            self.url,
            {
                'items': [{'stock_item_id': self.stock_item.pk, 'quantity': '1', 'unit_value': '10'}],
                'customer_id': 999999,
            },
            format='json',
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Invoice.objects.count(), 0)

    def test_non_customer_company_rejected(self):
        supplier = Company.objects.create(name='Not A Customer', is_customer=False, is_supplier=True)
        response = self.client.post(
            self.url,
            {
                'items': [{'stock_item_id': self.stock_item.pk, 'quantity': '1', 'unit_value': '10'}],
                'customer_id': supplier.pk,
            },
            format='json',
        )
        self.assertEqual(response.status_code, 400)

    def test_insufficient_stock_rejected_and_no_invoice_created(self):
        response = self.client.post(
            self.url,
            {
                'items': [{'stock_item_id': self.stock_item.pk, 'quantity': '999', 'unit_value': '10'}],
                'customer_id': self.customer.pk,
            },
            format='json',
        )
        self.assertEqual(response.status_code, 400)
        self.stock_item.refresh_from_db()
        self.assertEqual(self.stock_item.quantity, 50)
        self.assertEqual(Invoice.objects.count(), 0)

    def test_due_date_defaults_to_30_days(self):
        response = self.client.post(
            self.url,
            {
                'items': [{'stock_item_id': self.stock_item.pk, 'quantity': '1', 'unit_value': '10'}],
                'customer_id': self.customer.pk,
            },
            format='json',
        )
        invoice = Invoice.objects.get(id=response.data['invoice_id'])
        self.assertEqual(invoice.due_date, timezone.localdate() + timedelta(days=30))


@override_settings(USE_TZ=True)
class InvoicePaymentsApiTest(PluginRegistryMixin, APITestCase):
    def setUp(self):
        self.user = User.objects.create_user('pay-api-tester', password='pw', is_staff=True)
        self.client.force_login(self.user)
        cache.clear()  # reset DRF throttle counters shared across the suite
        self.customer = Company.objects.create(name='Acme Pharma', is_customer=True)
        self.invoice = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate(),
            total=Decimal('50000'),
            created_by=self.user,
        )
        self.url = reverse('plugin:nexainventory:invoice-payments', args=[self.invoice.pk])

    def test_partial_then_full_payment_flow(self):
        r1 = self.client.post(self.url, {'amount': '10000', 'method': 'cash'}, format='json')
        self.assertEqual(r1.status_code, 201, r1.content)
        self.assertEqual(r1.data['invoice_status'], 'partially_paid')
        self.assertEqual(Decimal(r1.data['outstanding']), Decimal('40000'))

        r2 = self.client.post(self.url, {'amount': '40000', 'method': 'online'}, format='json')
        self.assertEqual(r2.status_code, 201, r2.content)
        self.assertEqual(r2.data['invoice_status'], 'paid')
        self.assertEqual(Decimal(r2.data['outstanding']), Decimal('0'))

        history = self.client.get(self.url)
        self.assertEqual(len(history.data), 2)
        self.assertEqual(Decimal(history.data[0]['amount']), Decimal('10000'))

    def test_zero_payment_rejected(self):
        response = self.client.post(self.url, {'amount': '0', 'method': 'cash'}, format='json')
        self.assertEqual(response.status_code, 400)

    def test_negative_payment_rejected(self):
        response = self.client.post(self.url, {'amount': '-100', 'method': 'cash'}, format='json')
        self.assertEqual(response.status_code, 400)

    def test_overpayment_rejected(self):
        response = self.client.post(self.url, {'amount': '60000', 'method': 'cash'}, format='json')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.invoice.payments.count(), 0)

    def test_payment_against_cancelled_invoice_rejected(self):
        self.invoice.status = Invoice.Status.CANCELLED
        self.invoice.save(update_fields=['status'])
        response = self.client.post(self.url, {'amount': '100', 'method': 'cash'}, format='json')
        self.assertEqual(response.status_code, 400)

    def test_invalid_method_rejected(self):
        response = self.client.post(self.url, {'amount': '100', 'method': 'bitcoin'}, format='json')
        self.assertEqual(response.status_code, 400)


@override_settings(USE_TZ=True)
class InvoiceListApiTest(PluginRegistryMixin, APITestCase):
    def setUp(self):
        self.user = User.objects.create_user('list-tester', password='pw', is_staff=True)
        self.client.force_login(self.user)
        cache.clear()  # reset DRF throttle counters shared across the suite
        self.customer = Company.objects.create(name='Acme Pharma', is_customer=True)
        self.invoice1 = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate(),
            total=Decimal('500'),
            created_by=self.user,
        )
        self.invoice2 = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate() - timedelta(days=45),
            total=Decimal('1000'),
            created_by=self.user,
            status=Invoice.Status.CANCELLED,
        )

    def test_list_returns_all_invoices_with_expected_fields(self):
        url = reverse('plugin:nexainventory:invoice-list')
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data), 2)

        row = next(r for r in response.data if r['id'] == self.invoice1.id)
        self.assertEqual(row['reference'], self.invoice1.reference)
        self.assertEqual(row['customer_id'], self.customer.id)
        self.assertEqual(row['customer_name'], self.customer.name)
        self.assertEqual(Decimal(row['total']), Decimal('500'))
        self.assertEqual(Decimal(row['outstanding']), Decimal('500'))
        self.assertEqual(row['status'], 'unpaid')
        self.assertIn('aging_bucket', row)
        self.assertIn('is_overdue', row)
        self.assertIn('due_date', row)
        self.assertIn('invoice_date', row)

    def test_list_includes_cancelled_invoices(self):
        # This is a general listing endpoint, not the receivables report —
        # cancelled invoices should still be visible here.
        url = reverse('plugin:nexainventory:invoice-list')
        response = self.client.get(url)
        ids = [r['id'] for r in response.data]
        self.assertIn(self.invoice2.id, ids)

    def test_unauthenticated_rejected(self):
        self.client.logout()
        url = reverse('plugin:nexainventory:invoice-list')
        response = self.client.get(url)
        self.assertEqual(response.status_code, 401)


@override_settings(USE_TZ=True)
class InvoiceDetailApiTest(PluginRegistryMixin, APITestCase):
    def setUp(self):
        self.user = User.objects.create_user('detail-tester', password='pw', is_staff=True)
        self.client.force_login(self.user)
        cache.clear()  # reset DRF throttle counters shared across the suite
        self.customer = Company.objects.create(name='Acme Pharma', is_customer=True)
        self.invoice = Invoice.objects.create(
            customer=self.customer,
            due_date=timezone.localdate() - timedelta(days=45),
            total=Decimal('1000'),
            created_by=self.user,
        )

    def test_retrieve_invoice(self):
        url = reverse('plugin:nexainventory:invoice-detail', args=[self.invoice.pk])
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['reference'], self.invoice.reference)
        self.assertEqual(Decimal(response.data['outstanding']), Decimal('1000'))
        self.assertEqual(response.data['aging_bucket'], '31-60')

    def test_retrieve_missing_invoice_404(self):
        url = reverse('plugin:nexainventory:invoice-detail', args=[999999])
        response = self.client.get(url)
        self.assertEqual(response.status_code, 404)


@override_settings(USE_TZ=True)
class CustomerReceivablesApiTest(PluginRegistryMixin, APITestCase):
    def setUp(self):
        self.user = User.objects.create_user('receivables-tester', password='pw', is_staff=True)
        self.client.force_login(self.user)
        cache.clear()  # reset DRF throttle counters shared across the suite
        self.customer = Company.objects.create(name='Acme Pharma', is_customer=True)
        self.paid = Invoice.objects.create(
            customer=self.customer, due_date=timezone.localdate(), total=Decimal('100'),
            created_by=self.user, status=Invoice.Status.PAID,
        )
        Payment.objects.create(
            invoice=self.paid, amount=Decimal('100'), method=Payment.Method.CASH,
            recorded_by=self.user,
        )
        self.unpaid = Invoice.objects.create(
            customer=self.customer, due_date=timezone.localdate(), total=Decimal('300'),
            created_by=self.user,
        )
        self.cancelled = Invoice.objects.create(
            customer=self.customer, due_date=timezone.localdate(), total=Decimal('500'),
            created_by=self.user, status=Invoice.Status.CANCELLED,
        )

    def test_receivables_excludes_paid_and_cancelled(self):
        url = reverse('plugin:nexainventory:customer-receivables', args=[self.customer.pk])
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(Decimal(response.data['total_outstanding']), Decimal('300'))
        ids = [inv['id'] for inv in response.data['invoices']]
        self.assertEqual(ids, [self.unpaid.id])


@override_settings(USE_TZ=True)
class MovementListApiTest(PluginRegistryMixin, APITestCase):
    def setUp(self):
        self.user = User.objects.create_user('movement-tester', password='pw', is_staff=True)
        self.client.force_login(self.user)
        cache.clear()  # reset DRF throttle counters shared across the suite
        self.url = reverse('plugin:nexainventory:movement-list')

    def test_unauthenticated_rejected(self):
        self.client.logout()
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 401)

    def test_empty_result(self):
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['count'], 0)
        self.assertEqual(response.data['results'], [])

    def test_invalid_sale_type_rejected(self):
        response = self.client.get(self.url, {'sale_type': 'not_a_type'})
        self.assertEqual(response.status_code, 400)

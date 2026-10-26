"""Batch / expiry behaviour: earliest-expiry-first (FEFO) allocation and
blocking of expired stock, for both record-sale/ and record-b2b-sale/.
"""

from datetime import date, timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import override_settings
from django.urls import reverse
from rest_framework.test import APITestCase

from common.models import InvenTreeSetting
from company.models import Company
from InvenTree.unit_test import PluginRegistryMixin
from part.models import Part
from stock.models import StockItem

from .models import Invoice, SaleTypeMovement

User = get_user_model()


def _days(n):
    return date.today() + timedelta(days=n)


@override_settings(USE_TZ=True)
class ExpiryApiTestBase(PluginRegistryMixin, APITestCase):
    def setUp(self):
        self.user = User.objects.create_user('pharmacist', password='pw', is_staff=True)
        self.client.force_login(self.user)
        cache.clear()  # reset DRF throttle counters shared across the suite
        InvenTreeSetting.set_setting('STOCK_ENABLE_EXPIRY', True, None)
        InvenTreeSetting.set_setting('STOCK_ALLOW_EXPIRED_SALE', False, None)
        self.part = Part.objects.create(
            name='Paracetamol 500mg', description='Strip of 10', active=True, salable=True
        )
        self.sale_url = reverse('plugin:nexainventory:record-sale')
        self.b2b_url = reverse('plugin:nexainventory:record-b2b-sale')

    def batch(self, code, qty, expiry):
        return StockItem.objects.create(
            part=self.part, quantity=qty, batch=code, expiry_date=expiry
        )

    def sell_part(self, qty, **extra):
        return self.client.post(
            self.sale_url,
            {'part_id': self.part.pk, 'sale_type': 'b2c_cash', 'quantity': str(qty), **extra},
            format='json',
        )


class FefoAllocationTest(ExpiryApiTestBase):
    def test_takes_earliest_expiry_first_and_splits_across_batches(self):
        late = self.batch('LATE', 10, _days(300))
        soon = self.batch('SOON', 4, _days(20))
        mid = self.batch('MID', 10, _days(90))

        response = self.sell_part(9)
        self.assertEqual(response.status_code, 201, response.content)

        order = [(a['batch'], a['quantity']) for a in response.data['allocations']]
        self.assertEqual(order, [('SOON', '4'), ('MID', '5')])
        self.assertEqual(len(response.data['movement_ids']), 2)

        for item, expected in ((soon, 0), (mid, 5), (late, 10)):
            item.refresh_from_db()
            self.assertEqual(item.quantity, expected)
        self.assertEqual(SaleTypeMovement.objects.count(), 2)

    def test_stock_without_expiry_is_used_last(self):
        no_expiry = self.batch('NOEXP', 10, None)
        dated = self.batch('DATED', 3, _days(60))

        response = self.sell_part(5)
        self.assertEqual(response.status_code, 201, response.content)
        order = [a['batch'] for a in response.data['allocations']]
        self.assertEqual(order, ['DATED', 'NOEXP'])
        no_expiry.refresh_from_db()
        dated.refresh_from_db()
        self.assertEqual(no_expiry.quantity, 8)
        self.assertEqual(dated.quantity, 0)

    def test_expired_batches_are_skipped(self):
        expired = self.batch('OLD', 50, _days(-5))
        good = self.batch('GOOD', 10, _days(30))

        response = self.sell_part(6)
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual([a['batch'] for a in response.data['allocations']], ['GOOD'])
        expired.refresh_from_db()
        self.assertEqual(expired.quantity, 50)

    def test_only_expired_stock_left_is_rejected(self):
        expired = self.batch('OLD', 50, _days(-5))
        response = self.sell_part(1)
        self.assertEqual(response.status_code, 400)
        self.assertIn('Insufficient sellable stock', response.data['detail'])
        expired.refresh_from_db()
        self.assertEqual(expired.quantity, 50)
        self.assertEqual(SaleTypeMovement.objects.count(), 0)

    def test_insufficient_total_rolls_back_everything(self):
        a = self.batch('A', 3, _days(10))
        b = self.batch('B', 3, _days(20))
        response = self.sell_part(7)
        self.assertEqual(response.status_code, 400)
        a.refresh_from_db()
        b.refresh_from_db()
        self.assertEqual((a.quantity, b.quantity), (3, 3))

    def test_part_id_not_allowed_for_restock(self):
        self.batch('A', 3, _days(10))
        response = self.client.post(
            self.sale_url,
            {'part_id': self.part.pk, 'sale_type': 'restock', 'quantity': '5'},
            format='json',
        )
        self.assertEqual(response.status_code, 400)


class DepletedBatchHistoryTest(ExpiryApiTestBase):
    """Selling a batch down to zero must not erase the sale record."""

    def test_selling_whole_batch_keeps_batch_and_movement(self):
        item = self.batch('ONLY', 5, _days(30))
        response = self.sell_part(5)
        self.assertEqual(response.status_code, 201, response.content)
        self.assertTrue(StockItem.objects.filter(pk=item.pk).exists())
        item.refresh_from_db()
        self.assertEqual(item.quantity, 0)
        self.assertEqual(SaleTypeMovement.objects.count(), 1)

    def test_depleted_batch_not_offered_again(self):
        self.batch('ONLY', 5, _days(30))
        self.assertEqual(self.sell_part(5).status_code, 201)
        response = self.sell_part(1)
        self.assertEqual(response.status_code, 400)


class ExpiredBatchBlockingTest(ExpiryApiTestBase):
    def sell_item(self, item, qty=1):
        return self.client.post(
            self.sale_url,
            {'stock_item_id': item.pk, 'sale_type': 'b2c_cash', 'quantity': str(qty)},
            format='json',
        )

    def test_specific_expired_batch_is_rejected(self):
        expired = self.batch('OLD', 10, _days(-1))
        response = self.sell_item(expired)
        self.assertEqual(response.status_code, 400)
        self.assertIn('expired', response.data['detail'])
        expired.refresh_from_db()
        self.assertEqual(expired.quantity, 10)

    def test_expired_sale_allowed_when_setting_enabled(self):
        InvenTreeSetting.set_setting('STOCK_ALLOW_EXPIRED_SALE', True, None)
        expired = self.batch('OLD', 10, _days(-1))
        response = self.sell_item(expired, 2)
        self.assertEqual(response.status_code, 201, response.content)
        expired.refresh_from_db()
        self.assertEqual(expired.quantity, 8)

    def test_expiry_not_enforced_when_expiry_tracking_off(self):
        InvenTreeSetting.set_setting('STOCK_ENABLE_EXPIRY', False, None)
        expired = self.batch('OLD', 10, _days(-1))
        response = self.sell_item(expired, 2)
        self.assertEqual(response.status_code, 201, response.content)

    def test_unexpired_batch_sells_normally(self):
        item = self.batch('OK', 10, _days(30))
        response = self.sell_item(item, 3)
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(len(response.data['allocations']), 1)


class B2BFefoTest(ExpiryApiTestBase):
    def setUp(self):
        super().setUp()
        self.customer = Company.objects.create(name='City Clinic', is_customer=True)

    def test_part_line_spans_batches_in_one_invoice(self):
        soon = self.batch('SOON', 4, _days(15))
        later = self.batch('LATER', 20, _days(120))
        response = self.client.post(
            self.b2b_url,
            {
                'customer_id': self.customer.pk,
                'items': [{'part_id': self.part.pk, 'quantity': '6', 'unit_value': '12.50'}],
            },
            format='json',
        )
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response.data['line_count'], 2)
        self.assertEqual(Decimal(response.data['total']), Decimal('75.00'))
        invoice = Invoice.objects.get(pk=response.data['invoice_id'])
        self.assertEqual(invoice.lines.count(), 2)
        soon.refresh_from_db()
        later.refresh_from_db()
        self.assertEqual((soon.quantity, later.quantity), (0, 18))

    def test_expired_only_stock_rejects_whole_invoice(self):
        self.batch('OLD', 10, _days(-3))
        response = self.client.post(
            self.b2b_url,
            {
                'customer_id': self.customer.pk,
                'items': [{'part_id': self.part.pk, 'quantity': '1', 'unit_value': '5'}],
            },
            format='json',
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Invoice.objects.count(), 0)

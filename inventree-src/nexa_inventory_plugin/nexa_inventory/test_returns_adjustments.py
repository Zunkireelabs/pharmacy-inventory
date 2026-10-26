"""Stock adjustments (signed, approved) and sales returns against a bill."""

from datetime import date, timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import override_settings
from django.urls import reverse
from rest_framework.test import APITestCase

from common.models import InvenTreeSetting
from InvenTree.unit_test import PluginRegistryMixin
from part.models import Part
from stock.models import StockItem

from .models import SalesReturn, StockAdjustment

User = get_user_model()


def _days(n):
    return date.today() + timedelta(days=n)


@override_settings(USE_TZ=True)
class Base(PluginRegistryMixin, APITestCase):
    def setUp(self):
        self.user = User.objects.create_user('pharmacist', password='pw', is_staff=True)
        self.client.force_login(self.user)
        cache.clear()
        InvenTreeSetting.set_setting('STOCK_ENABLE_EXPIRY', True, None)
        self.part = Part.objects.create(name='Cetirizine 10 mg Tablet', description='x', salable=True)
        self.batch = StockItem.objects.create(
            part=self.part, quantity=50, batch='CET-1', expiry_date=_days(300)
        )


class AdjustStockTest(Base):
    def adjust(self, **extra):
        body = {
            'stock_item_id': self.batch.pk, 'quantity_change': -3,
            'reason': 'broken strips', 'approved_by': 'Manager Rai', **extra,
        }
        return self.client.post(reverse('plugin:nexainventory:adjust-stock'), body, format='json')

    def test_negative_adjustment_removes_stock_and_is_recorded(self):
        response = self.adjust(reference_no='ADJ-1')
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response.data['new_quantity'], '47')
        self.batch.refresh_from_db()
        self.assertEqual(self.batch.quantity, 47)
        record = StockAdjustment.objects.get()
        self.assertEqual((record.quantity_change, record.approved_by, record.reference_no),
                         (Decimal('-3'), 'Manager Rai', 'ADJ-1'))

    def test_positive_adjustment_adds_stock(self):
        self.assertEqual(self.adjust(quantity_change=5, reason='stock-take found extra').status_code, 201)
        self.batch.refresh_from_db()
        self.assertEqual(self.batch.quantity, 55)

    def test_validation(self):
        self.assertEqual(self.adjust(quantity_change=0).status_code, 400)
        self.assertEqual(self.adjust(quantity_change='abc').status_code, 400)
        self.assertEqual(self.adjust(reason='').status_code, 400)
        self.assertEqual(self.adjust(approved_by='').status_code, 400)
        self.assertEqual(self.adjust(quantity_change=-51).status_code, 400)
        self.assertEqual(self.adjust(stock_item_id=999999).status_code, 400)
        self.batch.refresh_from_db()
        self.assertEqual(self.batch.quantity, 50)
        self.assertEqual(StockAdjustment.objects.count(), 0)

    def test_removing_everything_keeps_the_batch(self):
        self.assertEqual(self.adjust(quantity_change=-50, reason='expired lot destroyed').status_code, 201)
        self.assertTrue(StockItem.objects.filter(pk=self.batch.pk).exists())

    def test_list_and_login(self):
        self.adjust()
        listing = self.client.get(reverse('plugin:nexainventory:adjustment-list'))
        self.assertEqual(listing.data['results'][0]['reason'], 'broken strips')
        self.client.logout()
        self.assertEqual(self.adjust().status_code, 401)


class SalesReturnTest(Base):
    def setUp(self):
        super().setUp()
        bill = self.client.post(
            reverse('plugin:nexainventory:record-bill'),
            {
                'sale_type': 'b2c_cash',
                'items': [{'part_id': self.part.pk, 'quantity': 10, 'unit_value': '4'}],
            },
            format='json',
        )
        self.assertEqual(bill.status_code, 201, bill.content)
        self.bill = bill.data
        self.line = bill.data['lines'][0]
        self.url = reverse('plugin:nexainventory:sales-return')

    def give_back(self, **extra):
        body = {
            'movement_id': self.line['movement_id'], 'quantity': 2,
            'reason': 'wrong medicine', 'disposition': 'resalable', **extra,
        }
        return self.client.post(self.url, body, format='json')

    def test_resalable_return_restores_stock_and_refunds(self):
        response = self.give_back()
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response.data['refund_amount'], '8.00')
        self.assertEqual(response.data['bill'], self.bill['reference'])
        self.batch.refresh_from_db()
        self.assertEqual(self.batch.quantity, 42)  # 50 - 10 sold + 2 back
        self.assertEqual(SalesReturn.objects.get().reference, f'RET-{response.data["id"]:05d}')

    def test_not_resalable_return_refunds_but_keeps_stock_out(self):
        response = self.give_back(disposition='not_resalable', reason='damaged')
        self.assertEqual(response.status_code, 201, response.content)
        self.batch.refresh_from_db()
        self.assertEqual(self.batch.quantity, 40)

    def test_cannot_return_more_than_sold_in_total(self):
        self.assertEqual(self.give_back(quantity=8).status_code, 201)
        too_many = self.give_back(quantity=3)
        self.assertEqual(too_many.status_code, 400)
        self.assertIn('Only 2', too_many.data['detail'])
        self.assertEqual(self.give_back(quantity=2).status_code, 201)

    def test_partial_refund_rate_and_its_limit(self):
        ok = self.give_back(unit_refund_rate='3')
        self.assertEqual(ok.data['refund_amount'], '6.00')
        self.assertEqual(self.give_back(unit_refund_rate='5').status_code, 400)

    def test_validation(self):
        self.assertEqual(self.give_back(reason='').status_code, 400)
        self.assertEqual(self.give_back(disposition='maybe').status_code, 400)
        self.assertEqual(self.give_back(quantity=0).status_code, 400)
        self.assertEqual(self.give_back(movement_id=999999).status_code, 400)
        self.assertEqual(SalesReturn.objects.count(), 0)

    def test_bill_shows_returned_quantity_and_list_works(self):
        self.give_back(quantity=4)
        detail = self.client.get(reverse('plugin:nexainventory:bill-detail', args=[self.bill['id']]))
        self.assertEqual(detail.data['lines'][0]['returned_quantity'], '4')
        listing = self.client.get(reverse('plugin:nexainventory:sales-return-list'))
        self.assertEqual(listing.data['results'][0]['refund_amount'], '16.00')

"""Pharmacy sale types, prescription / controlled flags, medicine API and the
expiry report.
"""

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

from .models import MedicineInfo, SaleTypeMovement

User = get_user_model()


def _days(n):
    return date.today() + timedelta(days=n)


@override_settings(USE_TZ=True)
class PharmacyBase(PluginRegistryMixin, APITestCase):
    def setUp(self):
        self.user = User.objects.create_user('pharmacist', password='pw', is_staff=True)
        self.client.force_login(self.user)
        cache.clear()  # reset DRF throttle counters shared across the suite
        InvenTreeSetting.set_setting('STOCK_ENABLE_EXPIRY', True, None)
        InvenTreeSetting.set_setting('STOCK_ALLOW_EXPIRED_SALE', False, None)
        self.part = Part.objects.create(
            name='Amoxicillin 500mg', description='Capsules', active=True, salable=True
        )
        self.item = StockItem.objects.create(
            part=self.part, quantity=100, batch='B1', expiry_date=_days(200)
        )
        self.sale_url = reverse('plugin:nexainventory:record-sale')

    def sell(self, sale_type, qty=2, **extra):
        return self.client.post(
            self.sale_url,
            {'part_id': self.part.pk, 'sale_type': sale_type, 'quantity': str(qty),
             'unit_value': '10', **extra},
            format='json',
        )

    def flag(self, **flags):
        MedicineInfo.objects.update_or_create(part=self.part, defaults=flags)


class PrescriptionRulesTest(PharmacyBase):
    def test_otc_part_sells_over_the_counter(self):
        self.assertEqual(self.sell('b2c_cash').status_code, 201)

    def test_prescription_only_part_blocked_over_the_counter(self):
        self.flag(requires_prescription=True)
        for sale_type in ('b2c_cash', 'b2c_online'):
            response = self.sell(sale_type)
            self.assertEqual(response.status_code, 400, sale_type)
            self.assertIn('Prescription Sale', response.data['detail'])
        self.item.refresh_from_db()
        self.assertEqual(self.item.quantity, 100)

    def test_prescription_sale_needs_prescriber(self):
        self.flag(requires_prescription=True)
        self.assertEqual(self.sell('prescription').status_code, 400)
        response = self.sell('prescription', prescriber='Dr. Sharma', prescription_ref='RX-1')
        self.assertEqual(response.status_code, 201, response.content)
        movement = SaleTypeMovement.objects.get()
        self.assertEqual(movement.sale_type, 'prescription')
        self.assertEqual(movement.prescriber, 'Dr. Sharma')
        self.assertEqual(movement.prescription_ref, 'RX-1')

    def test_controlled_medicine_also_needs_reference(self):
        self.flag(requires_prescription=True, is_controlled=True)
        response = self.sell('prescription', prescriber='Dr. Sharma')
        self.assertEqual(response.status_code, 400)
        self.assertIn('prescription_ref', response.data['detail'])
        ok = self.sell('prescription', prescriber='Dr. Sharma', prescription_ref='RX-9')
        self.assertEqual(ok.status_code, 201, ok.content)

    def test_prescription_sale_follows_earliest_expiry_first(self):
        StockItem.objects.create(part=self.part, quantity=5, batch='SOON', expiry_date=_days(10))
        response = self.sell('prescription', qty=7, prescriber='Dr. Rai')
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual([a['batch'] for a in response.data['allocations']], ['SOON', 'B1'])


class OtherSaleTypesTest(PharmacyBase):
    def test_return_adds_stock_back(self):
        response = self.client.post(
            self.sale_url,
            {'stock_item_id': self.item.pk, 'sale_type': 'return', 'quantity': '3'},
            format='json',
        )
        self.assertEqual(response.status_code, 201, response.content)
        self.item.refresh_from_db()
        self.assertEqual(self.item.quantity, 103)

    def test_part_id_not_allowed_for_return_or_writeoff(self):
        for sale_type in ('return', 'expiry_writeoff', 'restock'):
            self.assertEqual(self.sell(sale_type).status_code, 400, sale_type)

    def test_expiry_writeoff_removes_an_expired_batch(self):
        expired = StockItem.objects.create(
            part=self.part, quantity=12, batch='OLD', expiry_date=_days(-10)
        )
        response = self.client.post(
            self.sale_url,
            {'stock_item_id': expired.pk, 'sale_type': 'expiry_writeoff', 'quantity': '12'},
            format='json',
        )
        self.assertEqual(response.status_code, 201, response.content)
        expired.refresh_from_db()
        self.assertEqual(expired.quantity, 0)
        self.assertEqual(SaleTypeMovement.objects.filter(sale_type='expiry_writeoff').count(), 1)

    def test_expired_batch_cannot_be_sold_but_can_be_written_off(self):
        expired = StockItem.objects.create(
            part=self.part, quantity=4, batch='OLD', expiry_date=_days(-1)
        )
        sale = self.client.post(
            self.sale_url,
            {'stock_item_id': expired.pk, 'sale_type': 'b2c_cash', 'quantity': '1'},
            format='json',
        )
        self.assertEqual(sale.status_code, 400)

    def test_prescription_sales_count_in_sales_report(self):
        self.assertEqual(self.sell('prescription', qty=2, prescriber='Dr. A').status_code, 201)
        url = reverse('plugin:nexainventory:reports-sales')
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertIn('prescription', response.data['by_sale_type'])


class MedicineApiTest(PharmacyBase):
    def test_default_is_otc(self):
        url = reverse('plugin:nexainventory:medicine-detail', args=[self.part.pk])
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['requires_prescription'], False)
        self.assertEqual(response.data['is_controlled'], False)

    def test_set_flags_and_list(self):
        url = reverse('plugin:nexainventory:medicine-detail', args=[self.part.pk])
        response = self.client.put(url, {'requires_prescription': True}, format='json')
        self.assertEqual(response.status_code, 200, response.content)
        self.assertTrue(response.data['requires_prescription'])
        listing = self.client.get(reverse('plugin:nexainventory:medicine-list'))
        self.assertEqual([r['part_id'] for r in listing.data], [self.part.pk])

    def test_controlled_implies_prescription_only(self):
        url = reverse('plugin:nexainventory:medicine-detail', args=[self.part.pk])
        response = self.client.put(url, {'is_controlled': True}, format='json')
        self.assertTrue(response.data['is_controlled'])
        self.assertTrue(response.data['requires_prescription'])

    def test_only_staff_can_change_the_flags(self):
        pharmacist = User.objects.create_user('counter-staff', password='pw')  # not staff
        self.client.force_login(pharmacist)
        url = reverse('plugin:nexainventory:medicine-detail', args=[self.part.pk])
        denied = self.client.put(url, {'requires_prescription': True}, format='json')
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(self.client.patch(url, {'is_controlled': True}, format='json').status_code, 403)
        self.assertFalse(MedicineInfo.objects.filter(part=self.part).exists())
        # reading is still allowed for everyone who is logged in
        self.assertEqual(self.client.get(url).status_code, 200)
        self.assertEqual(self.client.get(reverse('plugin:nexainventory:medicine-list')).status_code, 200)
        # a staff user can
        self.client.force_login(self.user)
        self.assertEqual(self.client.put(url, {'requires_prescription': True}, format='json').status_code, 200)

    def test_rejects_non_boolean_and_unknown_part(self):
        url = reverse('plugin:nexainventory:medicine-detail', args=[self.part.pk])
        self.assertEqual(self.client.put(url, {'is_controlled': 'yes'}, format='json').status_code, 400)
        missing = reverse('plugin:nexainventory:medicine-detail', args=[999999])
        self.assertEqual(self.client.get(missing).status_code, 404)


class ExpiryReportTest(PharmacyBase):
    def test_report_lists_expired_and_expiring_batches(self):
        StockItem.objects.create(part=self.part, quantity=6, batch='EXPIRED', expiry_date=_days(-4))
        StockItem.objects.create(part=self.part, quantity=7, batch='SOON', expiry_date=_days(20))
        url = reverse('plugin:nexainventory:reports-expiry')
        response = self.client.get(url, {'days': 60})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual([r['batch'] for r in response.data['expired']], ['EXPIRED'])
        self.assertEqual([r['batch'] for r in response.data['expiring']], ['SOON'])
        self.assertEqual(response.data['expired'][0]['days_left'], -4)
        self.assertEqual(response.data['expiring'][0]['quantity'], '7')
        # the 200-day batch is outside a 60-day window
        self.assertNotIn('B1', [r['batch'] for r in response.data['expiring']])

    def test_depleted_batches_are_not_reported(self):
        StockItem.objects.create(part=self.part, quantity=0, batch='EMPTY', expiry_date=_days(-4))
        response = self.client.get(reverse('plugin:nexainventory:reports-expiry'))
        self.assertEqual(response.data['totals']['expired_batches'], 0)

    def test_invalid_days_rejected(self):
        url = reverse('plugin:nexainventory:reports-expiry')
        self.assertEqual(self.client.get(url, {'days': 'abc'}).status_code, 400)
        self.assertEqual(self.client.get(url, {'days': -1}).status_code, 400)

    def test_requires_login(self):
        self.client.logout()
        self.assertEqual(self.client.get(reverse('plugin:nexainventory:reports-expiry')).status_code, 401)

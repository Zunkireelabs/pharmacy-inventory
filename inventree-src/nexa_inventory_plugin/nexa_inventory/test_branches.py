"""Branches: selling takes stock only from the chosen branch."""

from datetime import date, timedelta

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import override_settings
from django.urls import reverse
from rest_framework.test import APITestCase

from common.models import InvenTreeSetting
from InvenTree.unit_test import PluginRegistryMixin
from part.models import Part
from stock.models import StockItem, StockLocation

from .models import SaleBill

User = get_user_model()


def _days(n):
    return date.today() + timedelta(days=n)


@override_settings(USE_TZ=True)
class BranchTest(PluginRegistryMixin, APITestCase):
    def setUp(self):
        self.user = User.objects.create_user('cashier', password='pw', is_staff=True)
        self.client.force_login(self.user)
        cache.clear()
        InvenTreeSetting.set_setting('STOCK_ENABLE_EXPIRY', True, None)
        self.main = StockLocation.objects.create(name='Main Branch')
        self.shelf = StockLocation.objects.create(name='Shelf A', parent=self.main)
        self.town = StockLocation.objects.create(name='Town Branch')
        self.part = Part.objects.create(name='Paracetamol 500 mg Tablet', description='x', salable=True)
        # earliest expiry is in the OTHER branch: must not be used for a Main Branch sale
        self.town_batch = StockItem.objects.create(
            part=self.part, quantity=50, batch='TOWN', expiry_date=_days(20), location=self.town
        )
        self.main_batch = StockItem.objects.create(
            part=self.part, quantity=30, batch='MAIN', expiry_date=_days(200), location=self.main
        )
        self.shelf_batch = StockItem.objects.create(
            part=self.part, quantity=10, batch='SHELF', expiry_date=_days(100), location=self.shelf
        )

    def bill(self, qty, branch=None):
        body = {
            'sale_type': 'b2c_cash',
            'items': [{'part_id': self.part.pk, 'quantity': qty, 'unit_value': '2'}],
        }
        if branch is not None:
            body['branch_id'] = branch.pk
        return self.client.post(reverse('plugin:nexainventory:record-bill'), body, format='json')

    def test_branches_list_has_only_top_level_locations(self):
        response = self.client.get(reverse('plugin:nexainventory:branch-list'))
        self.assertEqual([b['name'] for b in response.data], ['Main Branch', 'Town Branch'])

    def test_sale_uses_only_the_chosen_branch_including_sub_locations(self):
        response = self.bill(15, branch=self.main)
        self.assertEqual(response.status_code, 201, response.content)
        # SHELF (sub-location, earlier expiry) first, then MAIN; never TOWN
        self.assertEqual(
            [(l['batch'], l['quantity']) for l in response.data['lines']],
            [('SHELF', '10'), ('MAIN', '5')],
        )
        self.assertEqual(response.data['branch'], 'Main Branch')
        self.town_batch.refresh_from_db()
        self.assertEqual(self.town_batch.quantity, 50)
        self.assertEqual(SaleBill.objects.get().branch, self.main)

    def test_other_branch_stock_is_not_available(self):
        response = self.bill(45, branch=self.main)  # main has only 40
        self.assertEqual(response.status_code, 400)
        self.assertIn('Main Branch', response.data['detail'])

    def test_without_branch_all_stock_is_used_earliest_expiry_first(self):
        response = self.bill(5)
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response.data['lines'][0]['batch'], 'TOWN')
        self.assertEqual(response.data['branch'], '')

    def test_branch_must_be_top_level(self):
        self.assertEqual(self.bill(1, branch=self.shelf).status_code, 400)
        response = self.client.post(
            reverse('plugin:nexainventory:record-bill'),
            {
                'sale_type': 'b2c_cash', 'branch_id': 999999,
                'items': [{'part_id': self.part.pk, 'quantity': 1, 'unit_value': '2'}],
            },
            format='json',
        )
        self.assertEqual(response.status_code, 400)

    def test_expiry_report_can_be_filtered_by_branch(self):
        url = reverse('plugin:nexainventory:reports-expiry')
        everything = self.client.get(url, {'days': 365})
        self.assertEqual(len(everything.data['expiring']), 3)
        main_only = self.client.get(url, {'days': 365, 'branch': self.main.pk})
        self.assertEqual([r['batch'] for r in main_only.data['expiring']], ['SHELF', 'MAIN'])

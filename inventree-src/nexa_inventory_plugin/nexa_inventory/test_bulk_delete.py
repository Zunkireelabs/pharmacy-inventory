"""Bulk delete of products: unused products are deleted, products with any
stock or sales history are made inactive instead.
"""

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import override_settings
from django.urls import reverse
from rest_framework.test import APITestCase

from InvenTree.unit_test import PluginRegistryMixin
from part.models import Part
from stock.models import StockItem

from .models import MedicineInfo

User = get_user_model()


@override_settings(USE_TZ=True)
class BulkDeleteProductsTest(PluginRegistryMixin, APITestCase):
    def setUp(self):
        self.user = User.objects.create_user('owner', password='pw', is_staff=True)
        self.client.force_login(self.user)
        cache.clear()
        self.url = reverse('plugin:nexainventory:products-bulk-delete')
        self.unused = Part.objects.create(name='Unused', description='x', active=True)
        MedicineInfo.objects.create(part=self.unused, generic_name='Unused')
        self.stocked = Part.objects.create(name='Stocked', description='x', active=True)
        StockItem.objects.create(part=self.stocked, quantity=10, batch='B1')

    def post(self, ids):
        return self.client.post(self.url, {'part_ids': ids}, format='json')

    def test_deletes_unused_and_deactivates_used(self):
        response = self.post([self.unused.pk, self.stocked.pk, 999999])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['deleted'], 1)
        self.assertEqual(response.data['deactivated'], 1)
        self.assertEqual(response.data['not_found'], 1)
        self.assertFalse(Part.objects.filter(pk=self.unused.pk).exists())
        self.assertFalse(MedicineInfo.objects.filter(generic_name='Unused').exists())
        self.stocked.refresh_from_db()
        self.assertFalse(self.stocked.active)
        self.assertEqual(StockItem.objects.filter(part=self.stocked).count(), 1)

    def test_locked_unused_part_is_deleted(self):
        Part.objects.filter(pk=self.unused.pk).update(locked=True)
        self.assertEqual(self.post([self.unused.pk]).data['deleted'], 1)

    def test_non_staff_forbidden(self):
        clerk = User.objects.create_user('clerk', password='pw')
        self.client.force_login(clerk)
        self.assertEqual(self.post([self.unused.pk]).status_code, 403)
        self.assertTrue(Part.objects.filter(pk=self.unused.pk).exists())

    def test_bad_input(self):
        self.assertEqual(self.post([]).status_code, 400)
        self.assertEqual(self.post(['abc']).status_code, 400)
        self.assertEqual(
            self.client.post(self.url, {'part_ids': 5}, format='json').status_code, 400
        )

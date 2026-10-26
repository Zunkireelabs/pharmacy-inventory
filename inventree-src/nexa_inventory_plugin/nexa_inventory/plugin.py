"""Plugin definition for nexa_inventory."""

from django.urls import path
from django.views.decorators.csrf import csrf_exempt

from plugin import InvenTreePlugin
from plugin.mixins import AppMixin, ScheduleMixin, SettingsMixin, UrlsMixin


class NexaInventoryPlugin(ScheduleMixin, SettingsMixin, AppMixin, UrlsMixin, InvenTreePlugin):
    """Adds sale-type tracking (B2B credit / B2C cash / B2C online /
    Restock / Correction) and B2B receivables (invoices/payments) on top of
    InvenTree's stock model, without modifying core.
    """

    NAME = 'NexaInventory'
    SLUG = 'nexainventory'
    TITLE = 'Nexa Inventory'
    AUTHOR = 'internal'
    DESCRIPTION = 'Sale-type dimension + B2B receivables for stock movements'
    VERSION = '0.2.0'

    SETTINGS = {
        'INVOICE_REFERENCE_PATTERN': {
            'name': 'Invoice Reference Pattern',
            'description': (
                'Format pattern for generating B2B invoice reference numbers. '
                "Must include the '{ref}' placeholder."
            ),
            'default': 'INV-{ref:04d}',
        }
    }

    SCHEDULED_TASKS = {
        'check_invoice_due_dates': {'func': 'check_invoice_due_dates', 'schedule': 'D'}
    }

    def check_invoice_due_dates(self):
        # Deferred import: see setup_urls() below for why - plugin app isn't
        # registered in INSTALLED_APPS yet when this class is instantiated.
        from nexa_inventory.tasks import check_invoice_due_dates

        check_invoice_due_dates()

    def setup_urls(self):
        # UrlsMixin.__init__ calls setup_urls() immediately at plugin
        # instantiation — which happens during plugin discovery, BEFORE
        # AppMixin has added this plugin's app to INSTALLED_APPS and
        # triggered Django's app-registry reload. Importing api.py (which
        # imports models.py, which defines Django models) at that moment
        # fails because the models' app isn't registered yet. Deferring the
        # import into each view-dispatch function itself means it only runs
        # at request time, well after Django's app registry has settled.
        # Django's CSRF middleware checks the `csrf_exempt` attribute on the
        # callable actually registered in the URLconf — DRF's as_view()
        # carries that attribute, but our wrapper function (needed to defer
        # the import, see above) does not inherit it automatically just by
        # calling View.as_view() internally. Decorate explicitly.
        @csrf_exempt
        def record_sale_view(request, *args, **kwargs):
            from nexa_inventory.api import RecordSaleView

            return RecordSaleView.as_view()(request, *args, **kwargs)

        @csrf_exempt
        def record_b2b_sale_view(request, *args, **kwargs):
            from nexa_inventory.api import RecordB2BSaleView

            return RecordB2BSaleView.as_view()(request, *args, **kwargs)

        @csrf_exempt
        def invoice_list_view(request, *args, **kwargs):
            from nexa_inventory.api import InvoiceListView

            return InvoiceListView.as_view()(request, *args, **kwargs)

        @csrf_exempt
        def invoice_detail_view(request, *args, **kwargs):
            from nexa_inventory.api import InvoiceDetailView

            return InvoiceDetailView.as_view()(request, *args, **kwargs)

        @csrf_exempt
        def invoice_payments_view(request, *args, **kwargs):
            from nexa_inventory.api import InvoicePaymentsView

            return InvoicePaymentsView.as_view()(request, *args, **kwargs)

        @csrf_exempt
        def customer_receivables_view(request, *args, **kwargs):
            from nexa_inventory.api import CustomerReceivablesView

            return CustomerReceivablesView.as_view()(request, *args, **kwargs)

        @csrf_exempt
        def sales_summary_report_view(request, *args, **kwargs):
            from nexa_inventory.api import SalesSummaryReportView

            return SalesSummaryReportView.as_view()(request, *args, **kwargs)

        @csrf_exempt
        def receivables_summary_report_view(request, *args, **kwargs):
            from nexa_inventory.api import ReceivablesSummaryReportView

            return ReceivablesSummaryReportView.as_view()(request, *args, **kwargs)

        @csrf_exempt
        def medicine_info_view(request, *args, **kwargs):
            from nexa_inventory.api import MedicineInfoView

            return MedicineInfoView.as_view()(request, *args, **kwargs)

        @csrf_exempt
        def expiry_report_view(request, *args, **kwargs):
            from nexa_inventory.api import ExpiryReportView

            return ExpiryReportView.as_view()(request, *args, **kwargs)

        @csrf_exempt
        def movement_list_view(request, *args, **kwargs):
            from nexa_inventory.api import MovementListView

            return MovementListView.as_view()(request, *args, **kwargs)

        return [
            path('record-sale/', record_sale_view, name='record-sale'),
            path('record-b2b-sale/', record_b2b_sale_view, name='record-b2b-sale'),
            path('invoices/', invoice_list_view, name='invoice-list'),
            path('invoices/<int:pk>/', invoice_detail_view, name='invoice-detail'),
            path('invoices/<int:pk>/payments/', invoice_payments_view, name='invoice-payments'),
            path('customers/<int:pk>/receivables/', customer_receivables_view, name='customer-receivables'),
            path('reports/sales/', sales_summary_report_view, name='reports-sales'),
            path('reports/receivables/', receivables_summary_report_view, name='reports-receivables'),
            path('reports/expiry/', expiry_report_view, name='reports-expiry'),
            path('medicine/', medicine_info_view, name='medicine-list'),
            path('medicine/<int:part_id>/', medicine_info_view, name='medicine-detail'),
            path('movements/', movement_list_view, name='movement-list'),
        ]

"""Validation/generation helpers for the Invoice reference field.
Mirrors order/validators.py's thin-wrapper-around-classmethod pattern.
"""


def generate_next_invoice_reference():
    """Generate the next available Invoice reference."""
    from .models import Invoice

    return Invoice.generate_reference()


def validate_invoice_reference(value):
    """Validate that the Invoice reference field matches the required pattern."""
    from .models import Invoice

    Invoice.validate_reference_field(value)

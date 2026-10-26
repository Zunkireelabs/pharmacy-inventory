# Nexa Inventory roadmap

Product: **Nexa Inventory** (pharmacy). Repo folder: `pharmacy-inventory`.
Plugin: `nexa_inventory_plugin` / package `nexa_inventory` / slug `nexainventory`.

## v1 scope
- Batch + expiry tracking, earliest-expiry-first selling
- Rx / controlled flags (light; no compliance register yet)
- Retail + credit customers
- Supplier purchasing
- Several branches with stock transfers
- Currency is a setting (default NPR), not hard-coded

## Phases
1. **Strip and rename** (legacy clone -> Nexa): plugin/UI rename, branding, remove gift,
   deploy config, fresh migrations, docs.
2. **Pharmacy adaptation**
   - 2a batch + expiry: enable `STOCK_ENABLE_EXPIRY` / batch code / stale days, set
     `STOCK_ALLOW_EXPIRED_SALE=False`, FEFO-aware sale recording, batch/expiry in
     ProductPicker and sale form, near-expiry report, restore System Settings / Admin nav.
   - 2b sale types: OTC cash, prescription, credit (B2B), insurance (undecided),
     return, expiry write-off, restock, correction.
   - 2c Rx / controlled flags via part parameters + optional prescriber note.
   - 2d retail + credit: keep Invoice/Payment/aging; currency setting.
   - 2e purchasing: surface built-in purchase orders and suppliers.
   - 2f branches: top-level stock locations + built-in transfers.
3. **Deploy**: new GHCR image, host, VPS path, Supabase project, `VPS_*` secrets.

## Open questions
- GitHub account/org for the remote
- Insurance as a v1 sale type
- Per-branch permissions and branch-level reporting
- Unit handling: strips / loose tablets vs whole packs

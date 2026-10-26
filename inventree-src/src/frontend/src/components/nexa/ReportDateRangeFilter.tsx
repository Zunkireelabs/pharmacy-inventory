import { t } from '@lingui/core/macro';
import { SimpleGrid } from '@mantine/core';
import { DateInput, type DateValue } from '@mantine/dates';

/**
 * date_from/date_to filter, matching the API contract of all three
 * Nexa reporting endpoints exactly (ISO YYYY-MM-DD, both optional).
 */
export function ReportDateRangeFilter({
  dateFrom,
  dateTo,
  onDateFromChange,
  onDateToChange
}: Readonly<{
  dateFrom: DateValue;
  dateTo: DateValue;
  onDateFromChange: (value: DateValue) => void;
  onDateToChange: (value: DateValue) => void;
}>) {
  return (
    <SimpleGrid cols={{ base: 1, xs: 2 }} spacing='sm'>
      <DateInput
        label={t`From`}
        value={dateFrom}
        onChange={onDateFromChange}
        clearable
        maxDate={dateTo ?? undefined}
      />
      <DateInput
        label={t`To`}
        value={dateTo}
        onChange={onDateToChange}
        clearable
        minDate={dateFrom ?? undefined}
      />
    </SimpleGrid>
  );
}

/** Format a Mantine DateValue as the ISO YYYY-MM-DD string the API expects. */
export function formatDateParam(value: DateValue): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
}

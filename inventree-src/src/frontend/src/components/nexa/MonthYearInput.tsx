import { t } from '@lingui/core/macro';
import { Group, Input, Select } from '@mantine/core';
import { useMemo } from 'react';

export type MonthYear = { month: number | null; year: number | null };

export const EMPTY_MONTH_YEAR: MonthYear = { month: null, year: null };

const MONTHS = Array.from({ length: 12 }, (_, i) => {
  const value = String(i + 1).padStart(2, '0');
  return { value: String(i + 1), label: value };
});

/**
 * Expiry as printed on the pack: month + year only (e.g. 08 / 2029).
 * The server stores it as the last day of that month.
 */
export function MonthYearInput({
  label,
  value,
  onChange,
  required
}: Readonly<{
  label: string;
  value: MonthYear;
  onChange: (value: MonthYear) => void;
  required?: boolean;
}>) {
  const years = useMemo(() => {
    const now = new Date().getFullYear();
    return Array.from({ length: 16 }, (_, i) => String(now + i));
  }, []);

  return (
    <Input.Wrapper label={label} required={required}>
      <Group gap='xs' grow wrap='nowrap'>
        <Select
          aria-label={t`Expiry month`}
          placeholder={t`MM`}
          data={MONTHS}
          value={value.month ? String(value.month) : null}
          onChange={(v) => onChange({ ...value, month: v ? Number(v) : null })}
        />
        <Select
          aria-label={t`Expiry year`}
          placeholder={t`YYYY`}
          data={years}
          searchable
          value={value.year ? String(value.year) : null}
          onChange={(v) => onChange({ ...value, year: v ? Number(v) : null })}
        />
      </Group>
    </Input.Wrapper>
  );
}

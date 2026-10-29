import { t } from '@lingui/core/macro';
import { CloseButton, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

/**
 * A search input component that debounces user input
 */
export function SearchInput({
  disabled,
  debounce,
  placeholder,
  minWidth,
  searchCallback
}: Readonly<{
  disabled?: boolean;
  debounce?: number;
  placeholder?: string;
  minWidth?: number;
  searchCallback: (searchTerm: string) => void;
}>) {
  const [value, setValue] = useState<string>('');
  const [searchText] = useDebouncedValue(value, debounce ?? 500);

  useEffect(() => {
    searchCallback(searchText);
  }, [searchText]);

  return (
    <TextInput
      value={value}
      disabled={disabled}
      aria-label='table-search-input'
      leftSection={<IconSearch />}
      placeholder={placeholder ?? t`Search`}
      onChange={(event) => setValue(event.target.value)}
      style={{ minWidth: `${minWidth ?? 150}px` }}
      rightSection={
        value.length > 0 ? (
          <CloseButton
            size='xs'
            onClick={() => {
              setValue('');
              searchCallback('');
            }}
          />
        ) : null
      }
    />
  );
}

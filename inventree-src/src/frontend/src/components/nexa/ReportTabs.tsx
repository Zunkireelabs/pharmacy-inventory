import { t } from '@lingui/core/macro';
import { Tabs } from '@mantine/core';
import { useNavigate } from 'react-router-dom';

export function ReportTabs({
  active
}: Readonly<{ active: 'sales' | 'receivables' | 'gifts' }>) {
  const navigate = useNavigate();

  return (
    <Tabs
      value={active}
      onChange={(value) => value && navigate(`/reports/${value}/`)}
    >
      <Tabs.List>
        <Tabs.Tab value='sales'>{t`Sales`}</Tabs.Tab>
        <Tabs.Tab value='receivables'>{t`Receivables`}</Tabs.Tab>
        <Tabs.Tab value='gifts'>{t`Gifts`}</Tabs.Tab>
      </Tabs.List>
    </Tabs>
  );
}

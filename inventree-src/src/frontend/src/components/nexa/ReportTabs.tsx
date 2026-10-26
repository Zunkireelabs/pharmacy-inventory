import { t } from '@lingui/core/macro';
import { Tabs } from '@mantine/core';
import { useNavigate } from 'react-router-dom';

export function ReportTabs({
  active
}: Readonly<{ active: 'sales' | 'receivables' }>) {
  const navigate = useNavigate();

  return (
    <Tabs
      value={active}
      onChange={(value) => value && navigate(`/reports/${value}/`)}
    >
      <Tabs.List>
        <Tabs.Tab value='sales'>{t`Sales`}</Tabs.Tab>
        <Tabs.Tab value='receivables'>{t`Receivables`}</Tabs.Tab>
      </Tabs.List>
    </Tabs>
  );
}

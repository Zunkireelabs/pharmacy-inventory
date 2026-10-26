import { StylishText } from '@lib/components/StylishText';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import {
  Button,
  Center,
  Container,
  Divider,
  Group,
  Loader,
  Paper,
  Stack
} from '@mantine/core';
import { Outlet, useNavigate } from 'react-router-dom';
import SplashScreen from '../../components/SplashScreen';
import { InvenTreeLogo } from '../../components/items/InvenTreeLogo';
import { doLogout } from '../../functions/auth';

export default function LoginLayoutComponent() {
  return (
    <SplashScreen>
      <Center mih='100vh' p='lg'>
        <Container>
          <Stack align='center' gap='lg'>
            <Paper
              p='md'
              withBorder
              shadow='lg'
              radius='md'
              miw={425}
              style={{ textAlign: 'center' }}
            >
              <Stack align='center' gap={6}>
                <InvenTreeLogo size={96} large />
                <StylishText size='xl'>{t`Nexa Inventory`}</StylishText>
              </Stack>
            </Paper>
            <Outlet />
          </Stack>
        </Container>
      </Center>
    </SplashScreen>
  );
}

export function Wrapper({
  children,
  titleText,
  logOff = false,
  loader = false,
  smallPadding = false
}: Readonly<{
  children?: React.ReactNode;
  titleText: string;
  logOff?: boolean;
  loader?: boolean;
  smallPadding?: boolean;
}>) {
  const navigate = useNavigate();

  return (
    <Paper p='xl' withBorder miw={425} shadow='lg'>
      <Stack gap={smallPadding ? 0 : 'md'}>
        <StylishText size='xl'>{titleText}</StylishText>
        <Divider p='xs' />
        {loader && (
          <Group justify='center'>
            <Loader />
          </Group>
        )}
        {children}
        {logOff && (
          <>
            <Divider p='xs' />
            <Button onClick={() => doLogout(navigate)} color='red'>
              <Trans>Log off</Trans>
            </Button>
          </>
        )}
      </Stack>
    </Paper>
  );
}

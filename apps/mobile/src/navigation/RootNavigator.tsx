import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import { ErrorState, Loading } from '../components/ui';
import { useAuth } from '../lib/auth/auth-context';
import { ViewerProvider, useViewerState } from '../lib/viewer-context';
import { LeaderboardScreen } from '../screens/LeaderboardScreen';
import { MembershipScreen } from '../screens/MembershipScreen';
import { MyStatsScreen } from '../screens/MyStatsScreen';
import { SessionsScreen } from '../screens/SessionsScreen';
import { SignInScreen } from '../screens/SignInScreen';

export type TabParamList = {
  Leaderboard: undefined;
  MyStats: undefined;
  Sessions: undefined;
  Membership: undefined;
};

const Tab = createBottomTabNavigator<TabParamList>();

export function RootNavigator() {
  const { session } = useAuth();
  const scheme = useColorScheme();

  if (session === undefined) return <Loading />;
  if (session === null) return <SignInScreen />;

  return (
    <ViewerProvider userId={session.user.id}>
      <NavigationContainer theme={scheme === 'dark' ? DarkTheme : DefaultTheme}>
        <SignedIn />
      </NavigationContainer>
    </ViewerProvider>
  );
}

function SignedIn() {
  const { state, reload } = useViewerState();

  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') return <ErrorState message={state.error} onRetry={reload} />;
  if (state.data === null) return <NoPlayerRow />;

  return (
    <Tab.Navigator>
      <Tab.Screen name="Leaderboard" component={LeaderboardScreen} />
      <Tab.Screen name="MyStats" component={MyStatsScreen} options={{ title: 'My stats' }} />
      <Tab.Screen name="Sessions" component={SessionsScreen} />
      <Tab.Screen name="Membership" component={MembershipScreen} />
    </Tab.Navigator>
  );
}

/**
 * A session with no player row: an account that never finished signing up, or
 * whose row is gone. Treated exactly like the check after a code: drop the
 * session on this phone and say why on the sign-in screen.
 */
function NoPlayerRow() {
  const { signOut, setSignInNotice } = useAuth();
  useEffect(() => {
    setSignInNotice('unfinished');
    void signOut();
  }, [signOut, setSignInNotice]);
  return <Loading />;
}
